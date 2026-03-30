#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { HereyaEc2McpTemplateStack } from '../lib/hereya-ec2-mcp-template-stack';

const app = new cdk.App();
new HereyaEc2McpTemplateStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
