import * as cdk from "aws-cdk-lib";
import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Network } from "./constructs/network";
import { Service } from "./constructs/service";
import { Handler } from "./constructs/handler";
import { Stream } from "./constructs/stream";

export interface ALBAccessLogParserStackProps extends StackProps {
  serviceName: string;
  cidr: string;
  azPrimary: string;
  azSecondary: string;
  hostedZoneName: string;
  domainName: string;
  userDataFilePath: string;
}

export class ALBAccessLogParserStack extends Stack {
  constructor(scope: Construct, id: string, props: ALBAccessLogParserStackProps) {
    super(scope, id, props);

    const network = new Network(this, "Network", {
      cidr: props.cidr,
      azPrimary: props.azPrimary,
      azSecondary: props.azSecondary,
    });

    const service = new Service(this, "Service", {
      serviceName: props.serviceName,
      azPrimary: props.azPrimary,
      azSecondary: props.azSecondary,
      hostedZoneName: props.hostedZoneName,
      domainName: props.domainName,
      userDataFilePath: props.userDataFilePath,
      vpc: network.vpc,
      publicSubnets: network.publicSubnets,
      privateSubnets: network.privateSubnets,
      isolatedSubnets: network.isolatedSubnets,
    });

    const stream = new Stream(this, "Stream", {
      serviceName: props.serviceName,
      alb: service.alb,
    });

    new Handler(this, "Handler", {
      serviceName: props.serviceName,
      albLogBucket: service.albLogBucket,
      deliveryStream: stream.deliveryStream,
    });
  }
}
