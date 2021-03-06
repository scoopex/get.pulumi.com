// Copyright 2016-2018, Pulumi Corporation.  All rights reserved.

import * as fs from "fs";
import * as mime from "mime";
import * as path from "path";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import requestRewriteLambda from "./requestRewriter";

const cfg = new pulumi.Config(pulumi.getProject());

const subDomain = "get";
const domain = cfg.require("domain");
const fullDomain = `${subDomain}.${domain}`;
const certificateArn = cfg.require("certificateArn");

const contentBucket = new aws.s3.Bucket(`${fullDomain}-bucket`, {
    bucket: fullDomain,
    acl: "public-read",
});

// contentBucket needs to have the "public-read" ACL so its contents can be ready by CloudFront and
// served. But we deny the s3:ListBucket permission to prevent unintended disclosure of the bucket's
// contents. We also explicitly grant GetObject, in the event that the per-file ACL isn't set.
aws.getCallerIdentity().then((callerIdentity) => {
    const denyListPolicyState: aws.s3.BucketPolicyArgs = {
        bucket: contentBucket.bucket,
        policy: contentBucket.arn.apply((arn: string) => JSON.stringify({
            Version: "2008-10-17",
            Statement: [
                {
                    Effect: "Deny",
                    Principal: "*",
                    Action: "s3:ListBucket",
                    Resource: arn,
                    Condition: {
                        StringNotEquals: {
                            "aws:PrincipalAccount": callerIdentity.accountId,
                        },
                    },
                },
                {
                    Sid: "PluginsPublicRead",
                    Effect: "Allow",
                    Principal: "*",
                    Action: ["s3:GetObject"],
                    Resource: [`${arn}/releases/plugins/*`],
                },
                {
                    Sid: "SDKPublicRead",
                    Effect: "Allow",
                    Principal: "*",
                    Action: ["s3:GetObject"],
                    Resource: [`${arn}/releases/sdk/*`],
                }
            ],
        })),
    };

    const denyListPolicy = new aws.s3.BucketPolicy("deny-list", denyListPolicyState);
});

// IAM Role available to CI/CD bots to allow them to upload binaries as part of the release process.
// Previously we copied them to s3://rel.pulumi.com, but we later changed to uploading the binaries
// directly to s3://get.pulumi.com.
const uploadReleaseRole = new aws.iam.Role("PulumiUploadRelease", {
    name: "PulumiUploadRelease",
    description: "Upload new releases of the Pulumi SDK to get.pulumi.com.",
    assumeRolePolicy: {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Principal: {
                    AWS: [
                        // Pulumi's AWS bastion account. The IAM Users we use for CI/CD will be defined there.
                        "arn:aws:iam::318722933755:root",
                    ],
                },
                Action: "sts:AssumeRole",
                // Block assuming this role unless the external ID matches the following. This
                // isn't a security measure so much as a double-checking intent.
                Condition: {
                    StringEquals: {
                        "sts:ExternalId": [
                            "upload-pulumi-release"
                        ],
                    },
                },
            },
            // Allow the assumer to also set session tags.
            {
                Effect: "Allow",
                Principal: {
                    AWS: [
                        "arn:aws:iam::318722933755:root",
                    ],
                },
                Action: "sts:TagSession",
            }
        ],
    },
    tags: {
        "stack": `${pulumi.getProject()}/${pulumi.getStack()}`,
    },
});

// ARN of the role we need to hook up to our CI bots to enable them to upload releases.
export const uploadReleaseRoleArn = uploadReleaseRole.arn;

// Permissions granted to those who assume the upload releases role.
const uploadReleasePolicy = new aws.iam.Policy("PulumiUploadReleasePolicy", {
    name: "PulumiUploadReleasePolicy",
    description: "Upload Pulumi ",
    policy: {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                // Only allow uploading data. So `aws s3 cp` or `aws s3 ls` won't work.
                Action: [
                    "s3:PutObject",
                    "s3:PutObjectAcl",
                ],
                // Only allow uploading objects with certain prefixes.
                Resource: [
                    pulumi.interpolate`${contentBucket.arn}/releases/plugins/*`,
                    pulumi.interpolate`${contentBucket.arn}/releases/sdk/*`,
                ],
            },
        ],
    },
});

const rolePolicyAttachment = new aws.iam.RolePolicyAttachment("PulumiUploadReleasePolicyAttachment", {
    role: uploadReleaseRole,
    policyArn: uploadReleasePolicy.arn,
});

const logsBucket = new aws.s3.Bucket(`${fullDomain}-logs`, {
    acl: "log-delivery-write",
});

const distributionArgs: aws.cloudfront.DistributionArgs = {
    aliases: [fullDomain],
    defaultCacheBehavior: {
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        forwardedValues: {
            cookies: {
                forward: "none",
            },
            queryString: false,
        },
        targetOriginId: contentBucket.bucketDomainName.apply(d => `S3-${d}`),
        viewerProtocolPolicy: "redirect-to-https",

        // TTLs. These are used since presumably there aren't any cache control settings
        // for the individual S3 objects.
        minTtl: 0,
        defaultTtl: 604800,  // One week.
        maxTtl: 31536000,  // One year, the default.

        compress: true,

        // Include a Lambda to rewrite origin requests including a '+' to using '%2B' since S3 interprets '+' incorrectly
        lambdaFunctionAssociations: [{
            eventType: "origin-request",
            lambdaArn: requestRewriteLambda,
        }],
    },
    enabled: true,
    origins: [{
        domainName: contentBucket.bucketDomainName,
        originId: contentBucket.bucketDomainName.apply(d => `S3-${d}`),
    }],
    // Cache content from all CloudFront edge locations, meaning it will have the
    // best performance. Other price classes restrict some locations, which means
    // you would pay less for hosting the CDN.
    priceClass: "PriceClass_All",
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
    viewerCertificate: {
        acmCertificateArn: certificateArn,
        sslSupportMethod: "sni-only",
        minimumProtocolVersion: "TLSv1_2016",
    },
    loggingConfig: {
        bucket: logsBucket.bucketDomainName,
        includeCookies: false,
        prefix: `${fullDomain}/`,
    },
    defaultRootObject: "install.sh",
};

const cloudfront = new aws.cloudfront.Distribution(`${fullDomain}-cf`, distributionArgs);

const record = new aws.route53.Record(`${fullDomain}-record`, {
    name: subDomain,
    type: "A",
    zoneId: aws.route53.getZone({ name: domain }).then(x => x.zoneId),
    aliases: [
        {
            name: cloudfront.domainName,
            zoneId: cloudfront.hostedZoneId,
            evaluateTargetHealth: false,
        },
    ],
});

// Upload all the files in ../dist. We force the Content-Type header to text/plain so it renders nicely in a web
// browser when you view the page directly (for example, to inspect the script).
const distRoot = path.join("..", "dist");

for (let entry of fs.readdirSync(distRoot)) {
    const entryPath = path.join(distRoot, entry);
    if (fs.statSync(entryPath).isFile()) {
        // tslint:disable-next-line
        new aws.s3.BucketObject(entry, {
            bucket: contentBucket,
            contentType: "text/plain",
            source: new pulumi.asset.FileAsset(entryPath),
            acl: "public-read",
        });
    }
}

// Upload all the files in ../dist/new. We use the mime library to determine the Content-Type header of each file.
const distNewRoot = path.join(distRoot, "new");

for (let entry of fs.readdirSync(distNewRoot)) {
    const entryPath = path.join(distNewRoot, entry);
    if (fs.statSync(entryPath).isFile()) {
        // tslint:disable-next-line
        new aws.s3.BucketObject("new/" + entry, {
            bucket: contentBucket,
            contentType: mime.getType(entryPath) || undefined,
            source: new pulumi.asset.FileAsset(entryPath),
            acl: "public-read",
        });
    }
}
