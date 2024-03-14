import * as cdk from "aws-cdk-lib";
import { ApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";

export interface StreamProps {
  serviceName: string;
  alb: ApplicationLoadBalancer;
}

export class Stream extends Construct {
  readonly deliveryStream: cdk.aws_kinesisfirehose.CfnDeliveryStream;

  constructor(scope: Construct, id: string, props: StreamProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    // Create S3 bucket for transformed logs
    const dstBucket = new cdk.aws_s3.Bucket(this, "DestinationBucket", {
      bucketName: `${props.serviceName}-destination`,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      objectOwnership: cdk.aws_s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });

    // Create role for firehose stream
    const firehoseRole = new cdk.aws_iam.Role(this, "FirehoseRole", {
      roleName: `${props.serviceName}-firehose-role`,
      assumedBy: new cdk.aws_iam.ServicePrincipal("firehose.amazonaws.com"),
      inlinePolicies: {
        ["FirehoseRoleAdditionalPolicy"]: new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: [
                "s3:AbortMultipartUpload",
                "s3:GetBucketLocation",
                "s3:GetObject",
                "s3:ListBucket",
                "s3:ListBucketMultipartUploads",
                "s3:PutObject",
              ],
              resources: [dstBucket.bucketArn, `${dstBucket.bucketArn}/*`],
            }),
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ["logs:PutLogEvents"],
              resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/kinesisfirehose/*`],
            }),
          ],
        }),
      },
    });

    // Create log group and stream for firehose error logs
    const firehoseFailLogGroup = new cdk.aws_logs.LogGroup(this, "FirehoseFailLogGroup", {
      logGroupName: `/aws/kinesisfirehose/${props.serviceName}-firehose/fail`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: cdk.aws_logs.RetentionDays.THREE_DAYS,
    });
    const firehoseFailLogStream = new cdk.aws_logs.LogStream(this, "FirehoseFailLogStream", {
      logGroup: firehoseFailLogGroup,
      logStreamName: "logs",
    });

    // Create firehose delivery stream
    this.deliveryStream = new cdk.aws_kinesisfirehose.CfnDeliveryStream(this, "Firehose", {
      deliveryStreamName: `${props.serviceName}-firehose`,
      deliveryStreamType: "DirectPut",
      s3DestinationConfiguration: {
        bucketArn: dstBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseFailLogGroup.logGroupName,
          logStreamName: "logs",
        },
        compressionFormat: "GZIP",
        errorOutputPrefix: "/errors",
        bufferingHints: {
          sizeInMBs: 5,
          intervalInSeconds: 300,
        },
      },
    });

    this.deliveryStream._addResourceDependency(dstBucket.node.defaultChild as cdk.CfnResource);
    this.deliveryStream._addResourceDependency(firehoseFailLogGroup.node.defaultChild as cdk.CfnResource);
    this.deliveryStream._addResourceDependency(firehoseFailLogStream.node.defaultChild as cdk.CfnResource);
  }
}
