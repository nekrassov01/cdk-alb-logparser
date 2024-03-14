import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { readFileSync } from "fs";

export interface ServiceProps {
  serviceName: string;
  azPrimary: string;
  azSecondary: string;
  userDataFilePath: string;
  hostedZoneName: string;
  domainName: string;
  vpc: cdk.aws_ec2.IVpc;
  publicSubnets: cdk.aws_ec2.SubnetSelection;
  privateSubnets: cdk.aws_ec2.SubnetSelection;
  isolatedSubnets: cdk.aws_ec2.SubnetSelection;
}

export class Service extends Construct {
  readonly alb: cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer;
  readonly albLogBucket: cdk.aws_s3.Bucket;

  constructor(scope: Construct, id: string, props: ServiceProps) {
    super(scope, id);

    // Hosted zone
    const hostedZone = cdk.aws_route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: props.hostedZoneName,
    });

    // Certificate
    const certificate = new cdk.aws_certificatemanager.Certificate(this, "Certificate", {
      certificateName: `${props.serviceName}-certificate`,
      domainName: props.domainName,
      subjectAlternativeNames: [props.domainName, "*." + props.domainName],
      validation: cdk.aws_certificatemanager.CertificateValidation.fromDns(hostedZone),
    });

    // EC2 instance role (currently not in use)
    const ec2Role = new cdk.aws_iam.Role(this, "InstanceRole", {
      roleName: `${props.serviceName}-instance-role`,
      assumedBy: new cdk.aws_iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "SSMAccess",
          "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
        ),
      ],
    });
    new cdk.aws_iam.CfnInstanceProfile(this, "InstanceProfile", {
      instanceProfileName: `${props.serviceName}-instance-profile`,
      roles: [ec2Role.roleName],
    });

    // EC2 SecurityGroup
    const ec2SecurityGroupName = `${props.serviceName}-ec2-security-group`;
    const ec2SecurityGroup = new cdk.aws_ec2.SecurityGroup(this, "InstanceSecurityGroup", {
      securityGroupName: ec2SecurityGroupName,
      description: ec2SecurityGroupName,
      vpc: props.vpc,
      allowAllOutbound: true,
    });
    cdk.Tags.of(ec2SecurityGroup).add("Name", ec2SecurityGroupName);

    // EC2 UserData
    const userData = cdk.aws_ec2.UserData.forLinux({ shebang: "#!/bin/bash" });
    userData.addCommands(readFileSync(props.userDataFilePath, "utf8"));

    // EC2 LaunchTemplate
    const launchTemplate = new cdk.aws_ec2.LaunchTemplate(this, "LaunchTemplate", {
      launchTemplateName: `${props.serviceName}-template`,
      instanceType: cdk.aws_ec2.InstanceType.of(cdk.aws_ec2.InstanceClass.T3, cdk.aws_ec2.InstanceSize.MICRO),
      cpuCredits: cdk.aws_ec2.CpuCredits.STANDARD,
      machineImage: cdk.aws_ec2.MachineImage.latestAmazonLinux2({
        cpuType: cdk.aws_ec2.AmazonLinuxCpuType.X86_64,
      }),
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: cdk.aws_ec2.BlockDeviceVolume.ebs(8, {
            volumeType: cdk.aws_ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      securityGroup: ec2SecurityGroup,
      role: ec2Role,
      requireImdsv2: true,
      userData: userData,
    });

    // AutoScalingGroup
    const asg = new cdk.aws_autoscaling.AutoScalingGroup(this, "AutoScalingGroup", {
      autoScalingGroupName: `${props.serviceName}-instance`,
      launchTemplate: launchTemplate,
      minCapacity: 2,
      maxCapacity: 2,
      vpc: props.vpc,
      vpcSubnets: props.privateSubnets,
      healthCheck: cdk.aws_autoscaling.HealthCheck.elb({
        grace: cdk.Duration.minutes(10),
      }),
    });

    // Bucket for ALB access logs
    this.albLogBucket = new cdk.aws_s3.Bucket(this, "LogBucket", {
      bucketName: `${props.serviceName}-accesslogs`,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      objectOwnership: cdk.aws_s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    });

    // ALB security group
    const albSecurityGroupName = `${props.serviceName}-alb-security-group`;
    const albSecurityGroup = new cdk.aws_ec2.SecurityGroup(this, "ALBSecurityGroup", {
      securityGroupName: albSecurityGroupName,
      description: albSecurityGroupName,
      vpc: props.vpc,
      allowAllOutbound: false,
    });
    cdk.Tags.of(albSecurityGroup).add("Name", albSecurityGroupName);

    // ALB
    const albName = `${props.serviceName}-alb`;
    this.alb = new cdk.aws_elasticloadbalancingv2.ApplicationLoadBalancer(this, "ALB", {
      loadBalancerName: albName,
      vpc: props.vpc,
      vpcSubnets: props.publicSubnets,
      internetFacing: true,
      securityGroup: albSecurityGroup,
    });
    this.alb.logAccessLogs(this.albLogBucket, albName);
    this.alb.node.addDependency(asg);
    this.alb.node.addDependency(this.albLogBucket);
    albSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.ipv4("0.0.0.0/0"),
      cdk.aws_ec2.Port.tcp(443),
      "Allow access to ALB from anyone on port 443",
      false
    );
    albSecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.ipv4("0.0.0.0/0"),
      cdk.aws_ec2.Port.tcp(80),
      "Allow access to ALB from anyone on port 80",
      false
    );
    asg.connections.allowFrom(this.alb, cdk.aws_ec2.Port.tcp(80), "Allow access to EC2 instance from ALB on port 80");

    // ALB HTTPS listener
    this.alb.addListener("ListenerHTTPS", {
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      sslPolicy: cdk.aws_elasticloadbalancingv2.SslPolicy.TLS13_13,
      certificates: [
        {
          certificateArn: certificate.certificateArn,
        },
      ],
      defaultTargetGroups: [
        new cdk.aws_elasticloadbalancingv2.ApplicationTargetGroup(this, "ALBTargetGroup", {
          targetGroupName: `${props.serviceName}-alb-tg`,
          targetType: cdk.aws_elasticloadbalancingv2.TargetType.INSTANCE,
          targets: [asg],
          protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
          port: 80,
          healthCheck: {
            protocol: cdk.aws_elasticloadbalancingv2.Protocol.HTTP,
            port: "traffic-port",
          },
          vpc: props.vpc,
        }),
      ],
    });

    // ALB HTTP listener
    this.alb.addListener("ListenerHTTP", {
      protocol: cdk.aws_elasticloadbalancingv2.ApplicationProtocol.HTTP,
      defaultAction: cdk.aws_elasticloadbalancingv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        host: "#{host}",
        path: "/#{path}",
        query: "#{query}",
        permanent: true,
      }),
    });

    // EC2 Instance Connect endpoint SecurityGroup
    const eicSecurityGroupName = `${props.serviceName}-eic-security-group`;
    const eicSecurityGroup = new cdk.aws_ec2.SecurityGroup(this, "InstanceConnectSecurityGroup", {
      securityGroupName: eicSecurityGroupName,
      description: eicSecurityGroupName,
      vpc: props.vpc,
      allowAllOutbound: false,
    });
    cdk.Tags.of(eicSecurityGroup).add("Name", eicSecurityGroupName);
    eicSecurityGroup.connections.allowTo(
      asg,
      cdk.aws_ec2.Port.tcp(22),
      "Allow access to EC2 instance from EC2 Instance Connect on port 22"
    );

    // EC2 Instance Connect endpoint
    new cdk.aws_ec2.CfnInstanceConnectEndpoint(this, "InstanceConnectEndpoint", {
      subnetId: props.vpc.publicSubnets[0].subnetId,
      securityGroupIds: [eicSecurityGroup.securityGroupId],
      preserveClientIp: true,
      clientToken: `${props.serviceName}-eic-client-token`,
    });
    ec2SecurityGroup.addIngressRule(
      cdk.aws_ec2.Peer.securityGroupId(eicSecurityGroup.securityGroupId),
      cdk.aws_ec2.Port.tcp(22),
      "Allow access to EC2 instance from EC2 Instance Connect on port 22",
      false
    );

    // Alias record for ALB
    const albARecord = new cdk.aws_route53.ARecord(this, "DistributionARecord", {
      recordName: props.domainName,
      target: cdk.aws_route53.RecordTarget.fromAlias(new cdk.aws_route53_targets.LoadBalancerTarget(this.alb)),
      zone: hostedZone,
    });
    albARecord.node.addDependency(this.alb);
  }
}
