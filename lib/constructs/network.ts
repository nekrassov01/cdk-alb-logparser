import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface NetworkProps {
  cidr: string;
  azPrimary: string;
  azSecondary: string;
}

export class Network extends Construct {
  readonly vpc: cdk.aws_ec2.IVpc;
  readonly publicSubnets: cdk.aws_ec2.SubnetSelection;
  readonly privateSubnets: cdk.aws_ec2.SubnetSelection;
  readonly isolatedSubnets: cdk.aws_ec2.SubnetSelection;

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);

    this.vpc = new cdk.aws_ec2.Vpc(this, "VPC", {
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr(props.cidr),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      availabilityZones: [props.azPrimary, props.azSecondary],
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Private",
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "Isolated",
          subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      gatewayEndpoints: {
        S3: {
          service: cdk.aws_ec2.GatewayVpcEndpointAwsService.S3,
        },
      },
    });

    this.publicSubnets = this.vpc.selectSubnets({
      onePerAz: true,
      subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
    });
    this.privateSubnets = this.vpc.selectSubnets({
      onePerAz: true,
      subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS,
    });
    this.isolatedSubnets = this.vpc.selectSubnets({
      onePerAz: true,
      subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
    });
  }
}
