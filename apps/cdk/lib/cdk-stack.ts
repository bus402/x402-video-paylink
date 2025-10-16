import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { Construct } from "constructs";
import * as path from "path";

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC - use default VPC
    const vpc = ec2.Vpc.fromLookup(this, "VPC", {
      isDefault: true,
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, "X402ProxyCluster", {
      vpc,
      clusterName: "x402-proxy-cluster",
    });

    // Task Definition - Minimum specs (0.25 vCPU, 512 MB)
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "X402ProxyTaskDef",
      {
        cpu: 256, // 0.25 vCPU
        memoryLimitMiB: 512, // 512 MB
      }
    );

    // Container
    const container = taskDefinition.addContainer("X402ProxyContainer", {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, "../../.."), {
        file: "apps/paylink-server/Dockerfile",
      }),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "x402-proxy" }),
      environment: {
        NODE_ENV: "production",
        PORT: "3000",
        JWT_SECRET: process.env.JWT_SECRET!,
        MERCHANT_ADDRESS: process.env.MERCHANT_ADDRESS!,
        STREAM_PRICE_USDC: process.env.STREAM_PRICE_USDC!,
        X402_NETWORK: process.env.X402_NETWORK!,
        BASE_URL: process.env.BASE_URL!,
      },
    });

    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, "X402ProxyALB", {
      vpc,
      internetFacing: true,
      loadBalancerName: "x402-proxy-alb",
    });

    // Fargate Service
    const service = new ecs.FargateService(this, "X402ProxyService", {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
    });

    // Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "X402ProxyTargetGroup",
      {
        vpc,
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck: {
          path: "/health",
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      }
    );

    // Listener
    const listener = alb.addListener("X402ProxyListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, "PaylinkDistribution", {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
      comment: "X402 Video Paylink Distribution",
    });

    // Outputs
    new cdk.CfnOutput(this, "CloudFrontUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "CloudFront Distribution URL (HTTPS)",
    });

    new cdk.CfnOutput(this, "X402ProxyUrl", {
      value: `http://${alb.loadBalancerDnsName}`,
      description: "X402 Proxy ALB URL (Direct)",
    });

    new cdk.CfnOutput(this, "X402ProxyServiceName", {
      value: service.serviceName,
      description: "X402 Proxy Service Name",
    });
  }
}
