#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import "source-map-support/register";
import { ALBAccessLogParserStack } from "../lib/stack";

const app = new App();

// Get context
const owner = app.node.tryGetContext("owner");
const serviceName = app.node.tryGetContext("serviceName");
const hostedZoneName = app.node.tryGetContext("hostedZoneName");
const domainName = `${serviceName}.${hostedZoneName}`;

// Deploy stack
new ALBAccessLogParserStack(app, "ALBAccessLogParserStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "ap-northeast-1",
  },
  terminationProtection: false,
  serviceName: serviceName,
  cidr: "10.0.0.0/16",
  azPrimary: "ap-northeast-1a",
  azSecondary: "ap-northeast-1c",
  hostedZoneName: hostedZoneName,
  domainName: domainName,
  userDataFilePath: "./src/ec2/userdata.sh",
});

// Tagging all resources
Tags.of(app).add("Owner", owner);
