import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface HandlerProps {
  serviceName: string;
  albLogBucket: cdk.aws_s3.Bucket;
  deliveryStream: cdk.aws_kinesisfirehose.CfnDeliveryStream;
}

export class Handler extends Construct {
  constructor(scope: Construct, id: string, props: HandlerProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    // Create role for lambda function
    const logParserRole = new cdk.aws_iam.Role(this, "LogParserRole", {
      roleName: `${props.serviceName}-logparser-role`,
      assumedBy: new cdk.aws_iam.ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        ["HandlerLogParserRoleAdditionalPolicy"]: new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
              resources: ["arn:aws:logs:*:*:*"],
            }),
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ["firehose:DescribeStream", "firehose:GetRecords", "firehose:PutRecordBatch"],
              resources: [`arn:aws:firehose:${stack.region}:${stack.account}:deliverystream/*`],
            }),
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: ["s3:GetObject", "s3:GetBucketLocation", "s3:ListBucket"],
              resources: [`arn:aws:s3:::*`],
            }),
          ],
        }),
      },
    });

    // Create DLQ
    const logParserDLQ = new cdk.aws_sqs.Queue(this, "LogParserQueue", {
      queueName: `${props.serviceName}-logparser-dlq`,
      encryption: cdk.aws_sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retentionPeriod: cdk.Duration.days(7),
    });

    // Create lambda function
    const logParser = new cdk.aws_lambda.Function(this, "LogParser", {
      functionName: `${props.serviceName}-logparser`,
      description: "Parsing ALB logs and put to firehose",
      code: cdk.aws_lambda.Code.fromAsset("src/lambda/logparser", {
        bundling: {
          image: cdk.DockerImage.fromRegistry("golang:1.22.0"),
          command: [
            "bash",
            "-c",
            [
              "export GOCACHE=/tmp/go-cache",
              "export GOPATH=/tmp/go-path",
              "CGO_ENABLED=0 GOOS=linux go build -tags lambda.norpc -o /asset-output/bootstrap main.go",
            ].join(" && "),
          ],
        },
      }),
      handler: "bootstrap",
      architecture: cdk.aws_lambda.Architecture.ARM_64,
      runtime: cdk.aws_lambda.Runtime.PROVIDED_AL2,
      role: logParserRole,
      logRetention: cdk.aws_logs.RetentionDays.THREE_DAYS,
      currentVersionOptions: {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
      deadLetterQueueEnabled: true,
      deadLetterQueue: logParserDLQ,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      retryAttempts: 2,
      environment: {
        FIREHOSE_STREAM_NAME: props.deliveryStream.deliveryStreamName!,
      },
    });

    // Update function alias
    const alias = new cdk.aws_lambda.Alias(scope, "LogParserAlias", {
      aliasName: "live",
      version: logParser.currentVersion,
    });

    // Set function alias to S3 event
    props.albLogBucket.addEventNotification(
      cdk.aws_s3.EventType.OBJECT_CREATED_PUT,
      new cdk.aws_s3_notifications.LambdaDestination(alias)
    );
  }
}
