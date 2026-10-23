import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  color?: string;
}

// ─── AWS Provider Logo ────────────────────────────────────────────────────────
export function AwsIcon({ size = 24, className = '', color }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} role="img" aria-label="AWS">
      {/* Official AWS 'aws' Lettermark */}
      <path
        d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.777.777 0 0 0-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.652 3.652 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167z"
        fill={color || 'currentColor'}
      />
      {/* Official Amazon Smile Curve & Arrow */}
      <path
        d="M21.698 16.207c-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351 3.384 1.963 7.559 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.439-.2.814.287.383.607z"
        fill="#FF9900"
      />
      <path
        d="M22.792 14.961c-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151.32-.79 1.03-2.57.695-2.994z"
        fill="#FF9900"
      />
    </svg>
  );
}

// ─── AWS ElastiCache (In-Memory Cache) ─────────────────────────────────────────
export function AwsElastiCacheIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#C925D1" fillOpacity="0.16" />
      <path d="M24 10l12 6-12 6-12-6 12-6z" fill="#C925D1" />
      <path d="M12 16l12 6v7l-12-6v-7z" fill="#A81BB0" />
      <path d="M36 16l-12 6v7l12-6v-7z" fill="#E254E9" />
      <path d="M12 25l12 6 12-6" stroke="#C925D1" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 31l12 6 12-6" stroke="#C925D1" strokeWidth="2" strokeLinecap="round" />
      <circle cx="24" cy="22" r="2" fill="#FFF" />
    </svg>
  );
}

// ─── AWS VPC (Networking & Content Delivery) ──────────────────────────────────
export function AwsVpcIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#8C4FFF" fillOpacity="0.15" />
      <rect x="6" y="6" width="36" height="36" rx="6" stroke="#8C4FFF" strokeWidth="2.5" strokeDasharray="3 3" />
      <circle cx="16" cy="18" r="4" fill="#8C4FFF" />
      <circle cx="32" cy="18" r="4" fill="#8C4FFF" />
      <circle cx="24" cy="32" r="4" fill="#8C4FFF" />
      <path d="M18 20l4.5 9.5M30 20l-4.5 9.5M19 18h10" stroke="#8C4FFF" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ─── AWS Subnet ───────────────────────────────────────────────────────────────
export function AwsSubnetIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#059669" fillOpacity="0.15" />
      <rect x="7" y="7" width="34" height="34" rx="5" stroke="#059669" strokeWidth="2" strokeDasharray="4 3" />
      <rect x="12" y="14" width="10" height="8" rx="2" fill="#059669" />
      <rect x="26" y="14" width="10" height="8" rx="2" fill="#059669" fillOpacity="0.7" />
      <path d="M17 22v6h14v-6" stroke="#059669" strokeWidth="2" fill="none" />
      <circle cx="24" cy="34" r="3" fill="#059669" />
      <path d="M24 28v3" stroke="#059669" strokeWidth="2" />
    </svg>
  );
}

// ─── AWS EC2 (Compute) ────────────────────────────────────────────────────────
export function AwsEc2Icon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#FF9900" fillOpacity="0.18" />
      <path
        d="M24 8l14 8v16l-14 8-14-8V16l14-8z"
        fill="#ED7100"
      />
      <path
        d="M24 8l14 8-14 8-14-8 14-8z"
        fill="#FF9900"
      />
      <path
        d="M10 16l14 8v16l-14-8V16z"
        fill="#D66400"
      />
      {/* Circuit lines */}
      <path d="M19 23v4M24 26v4M29 23v4" stroke="#FFF" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="19" cy="22" r="1.2" fill="#FFF" />
      <circle cx="24" cy="25" r="1.2" fill="#FFF" />
      <circle cx="29" cy="22" r="1.2" fill="#FFF" />
    </svg>
  );
}

// ─── AWS Application Load Balancer (ALB) ─────────────────────────────────────
export function AwsAlbIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#8C4FFF" fillOpacity="0.15" />
      {/* Scaled balance node */}
      <circle cx="24" cy="13" r="5" fill="#8C4FFF" />
      <circle cx="13" cy="33" r="4.5" fill="#8C4FFF" />
      <circle cx="24" cy="35" r="4.5" fill="#8C4FFF" />
      <circle cx="35" cy="33" r="4.5" fill="#8C4FFF" />
      <path
        d="M24 18v6m0 0l-9 5m9-5l9 5m-9-5v7"
        stroke="#8C4FFF"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path d="M21 13h6M24 10v6" stroke="#FFF" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── AWS Auto Scaling ─────────────────────────────────────────────────────────
export function AwsAutoScalingIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#ED7100" fillOpacity="0.15" />
      <rect x="14" y="14" width="20" height="20" rx="3" stroke="#ED7100" strokeWidth="2.5" fill="#ED7100" fillOpacity="0.3" />
      {/* Expand arrows */}
      <path d="M24 8v5M24 8l-3 3M24 8l3 3" stroke="#ED7100" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M24 40v-5M24 40l-3-3M24 40l3-3" stroke="#ED7100" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 24h5M8 24l3-3M8 24l3 3" stroke="#ED7100" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M40 24h-5M40 24l-3-3M40 24l3 3" stroke="#ED7100" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── AWS S3 (Storage) ─────────────────────────────────────────────────────────
export function AwsS3Icon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#7AA116" fillOpacity="0.18" />
      {/* S3 Bucket/cylinders */}
      <path
        d="M24 10c7.7 0 14 2.2 14 5v18c0 2.8-6.3 5-14 5s-14-2.2-14-5V15c0-2.8 6.3-5 14-5z"
        fill="#7AA116"
      />
      <ellipse cx="24" cy="15" rx="14" ry="5" fill="#93C527" />
      <path d="M10 24c0 2.8 6.3 5 14 5s14-2.2 14-5" stroke="#5E800F" strokeWidth="2" fill="none" />
      <path d="M10 33c0 2.8 6.3 5 14 5s14-2.2 14-5" stroke="#5E800F" strokeWidth="2" fill="none" />
      <circle cx="24" cy="15" r="2.5" fill="#FFF" />
    </svg>
  );
}

// ─── AWS RDS (Database) ───────────────────────────────────────────────────────
export function AwsRdsIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#C925D1" fillOpacity="0.18" />
      <path
        d="M12 14c0-3.3 5.4-6 12-6s12 2.7 12 6v20c0 3.3-5.4 6-12 6s-12-2.7-12-6V14z"
        fill="#C925D1"
      />
      <ellipse cx="24" cy="14" rx="12" ry="5" fill="#E26FE8" />
      <path d="M12 22c0 2.8 5.4 5 12 5s12-2.2 12-5" stroke="#8A1190" strokeWidth="2" fill="none" />
      <path d="M12 30c0 2.8 5.4 5 12 5s12-2.2 12-5" stroke="#8A1190" strokeWidth="2" fill="none" />
      <path d="M21 14h6M24 11v6" stroke="#FFF" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── AWS Lambda (Serverless) ──────────────────────────────────────────────────
export function AwsLambdaIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#ED7100" fillOpacity="0.15" />
      <path
        d="M14 36l8-20h5l8 20h-5.5l-5.5-14-5 14H14z"
        fill="#ED7100"
      />
      <path d="M21 12h14v4H25l-4 10-4-10h-3v-4z" fill="#FF9900" />
    </svg>
  );
}

// ─── AWS ECS (Containers) ─────────────────────────────────────────────────────
export function AwsEcsIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#ED7100" fillOpacity="0.15" />
      <rect x="9" y="9" width="13" height="13" rx="2.5" fill="#ED7100" />
      <rect x="26" y="9" width="13" height="13" rx="2.5" fill="#FF9900" />
      <rect x="9" y="26" width="13" height="13" rx="2.5" fill="#FF9900" />
      <rect x="26" y="26" width="13" height="13" rx="2.5" fill="#ED7100" />
      <circle cx="24" cy="24" r="3.5" fill="#FFF" />
      <path d="M22 15h4M15 22v4M33 22v4M22 33h4" stroke="#FFF" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── AWS EKS (Kubernetes) ─────────────────────────────────────────────────────
export function AwsEksIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#ED7100" fillOpacity="0.15" />
      <circle cx="24" cy="24" r="15" stroke="#ED7100" strokeWidth="2.5" fill="#ED7100" fillOpacity="0.1" />
      <circle cx="24" cy="24" r="5" fill="#ED7100" />
      <path d="M24 9v7M24 32v7M9 24h7M32 24h7M13 13l5 5M30 30l5 5M13 35l5-5M30 18l5-5" stroke="#ED7100" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ─── AWS IAM (Security) ───────────────────────────────────────────────────────
export function AwsIamIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#DD344C" fillOpacity="0.18" />
      <path
        d="M24 7l14 5v12c0 9.5-6 15.5-14 18-8-2.5-14-8.5-14-18V12l14-5z"
        fill="#DD344C"
      />
      <circle cx="24" cy="20" r="4.5" fill="#FFF" />
      <path d="M17 31c0-4 3.5-6 7-6s7 2 7 6v1H17v-1z" fill="#FFF" />
    </svg>
  );
}

// ─── AWS KMS ──────────────────────────────────────────────────────────────────
export function AwsKmsIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#DD344C" fillOpacity="0.18" />
      <circle cx="20" cy="22" r="7" stroke="#DD344C" strokeWidth="3" fill="#FFF" />
      <path d="M26 24l12 1v4l-3 1v3l-3 1v-3l-2-1" stroke="#DD344C" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="19" cy="21" r="2.5" fill="#DD344C" />
    </svg>
  );
}

// ─── AWS CloudWatch ───────────────────────────────────────────────────────────
export function AwsCloudwatchIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#E7157B" fillOpacity="0.15" />
      <circle cx="24" cy="24" r="14" stroke="#E7157B" strokeWidth="2.5" fill="none" />
      <path d="M15 28l6-8 5 5 7-10" stroke="#E7157B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="33" cy="15" r="2.5" fill="#E7157B" />
    </svg>
  );
}

// ─── AWS Internet Gateway ─────────────────────────────────────────────────────
export function AwsIgwIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#8C4FFF" fillOpacity="0.15" />
      <circle cx="24" cy="24" r="13" stroke="#8C4FFF" strokeWidth="2" strokeDasharray="3 2" fill="none" />
      <path d="M11 24h26M24 11v26" stroke="#8C4FFF" strokeWidth="1.8" />
      <path d="M14 18c3-4 7-6 10-6s7 2 10 6M14 30c3 4 7 6 10 6s7-2 10-6" stroke="#8C4FFF" strokeWidth="1.8" />
      {/* Gateway portal arrows */}
      <path d="M21 21l3-3 3 3M24 18v12M21 27l3 3 3-3" stroke="#8C4FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── AWS NAT Gateway ──────────────────────────────────────────────────────────
export function AwsNatIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#8C4FFF" fillOpacity="0.15" />
      <rect x="8" y="14" width="32" height="20" rx="4" stroke="#8C4FFF" strokeWidth="2.5" fill="#8C4FFF" fillOpacity="0.2" />
      {/* Bidirectional arrows with IP translation nodes */}
      <path d="M15 21h12m0 0l-3-3m3 3l-3 3" stroke="#8C4FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M33 27H21m0 0l3-3m-3 3l3 3" stroke="#8C4FFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── AWS Route Table ──────────────────────────────────────────────────────────
export function AwsRouteTableIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#8C4FFF" fillOpacity="0.15" />
      <rect x="9" y="10" width="30" height="28" rx="3" stroke="#8C4FFF" strokeWidth="2" fill="none" />
      <path d="M9 19h30M9 28h30M21 10v28" stroke="#8C4FFF" strokeWidth="1.8" />
      <circle cx="15" cy="14.5" r="1.5" fill="#8C4FFF" />
      <circle cx="15" cy="23.5" r="1.5" fill="#8C4FFF" />
      <circle cx="15" cy="32.5" r="1.5" fill="#8C4FFF" />
    </svg>
  );
}

// ─── AWS Security Group ───────────────────────────────────────────────────────
export function AwsSgIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#DD344C" fillOpacity="0.18" />
      <path
        d="M24 7l13 4v11c0 9-5.5 15-13 18-7.5-3-13-9-13-18V11l13-4z"
        stroke="#DD344C"
        strokeWidth="2.5"
        fill="#DD344C"
        fillOpacity="0.25"
      />
      <path d="M19 19h10M16 24h16M19 29h10" stroke="#DD344C" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ─── AWS EBS Volume ───────────────────────────────────────────────────────────
export function AwsEbsIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#7AA116" fillOpacity="0.18" />
      <rect x="10" y="10" width="28" height="28" rx="4" stroke="#7AA116" strokeWidth="2.5" fill="#7AA116" fillOpacity="0.2" />
      <circle cx="24" cy="24" r="6" stroke="#7AA116" strokeWidth="2" />
      <circle cx="24" cy="24" r="2" fill="#7AA116" />
      <path d="M10 24h7M31 24h7M24 10v7M24 31v7" stroke="#7AA116" strokeWidth="2" />
    </svg>
  );
}

// ─── AWS DynamoDB ─────────────────────────────────────────────────────────────
export function AwsDynamodbIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#3B48CC" fillOpacity="0.18" />
      <ellipse cx="24" cy="14" rx="13" ry="5" fill="#3B48CC" />
      <path d="M11 14v20c0 3 6 5 13 5s13-2 13-5V14" stroke="#3B48CC" strokeWidth="2.5" fill="none" />
      <path d="M11 24c0 3 6 5 13 5s13-2 13-5" stroke="#3B48CC" strokeWidth="2" fill="none" />
      {/* Lightning bolt key */}
      <path d="M25 18l-5 7h4l-2 7 6-8h-4l2-6z" fill="#FF9900" />
    </svg>
  );
}

// ─── AWS CloudFront (CDN) ─────────────────────────────────────────────────────
export function AwsCloudFrontIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#8C4FFF" fillOpacity="0.18" />
      {/* Central Global Edge Network Globe */}
      <circle cx="24" cy="24" r="14" stroke="#8C4FFF" strokeWidth="2.5" fill="#8C4FFF" fillOpacity="0.12" />
      {/* Longitudinal and Latitudinal Lines */}
      <ellipse cx="24" cy="24" rx="7" ry="14" stroke="#8C4FFF" strokeWidth="1.8" />
      <line x1="10" y1="24" x2="38" y2="24" stroke="#8C4FFF" strokeWidth="1.8" />
      <path d="M12 17c4 3 8 4 12 4s8-1 12-4" stroke="#8C4FFF" strokeWidth="1.5" />
      <path d="M12 31c4-3 8-4 12-4s8 1 12 4" stroke="#8C4FFF" strokeWidth="1.5" />
      {/* Edge POP Location Indicators */}
      <circle cx="17" cy="24" r="2.5" fill="#FF9900" />
      <circle cx="31" cy="24" r="2.5" fill="#FF9900" />
      <circle cx="24" cy="15" r="2.2" fill="#FF9900" />
      <circle cx="24" cy="33" r="2.2" fill="#FF9900" />
      {/* Radiating CDN Distribution Wave Markers */}
      <path d="M8 12c2-2 5-3 8-3M32 9c3 0 6 1 8 3M40 36c-2 2-5 3-8 3M16 39c-3 0-6-1-8-3" stroke="#FF9900" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ─── Internet / Public Traffic Ingress ────────────────────────────────────────
export function AwsInternetIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0284C7" fillOpacity="0.18" />
      {/* Public Internet Cloud Shape */}
      <path
        d="M17 33h16a8 8 0 003.5-15.2A11 11 0 0015.5 19 8.5 8.5 0 0017 33z"
        fill="#0284C7"
        fillOpacity="0.3"
        stroke="#0284C7"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* World / Ingress Grid Nodes inside Cloud */}
      <circle cx="24" cy="24" r="5" stroke="#38BDF8" strokeWidth="1.8" fill="#0369A1" />
      <path d="M19 24h10M24 19v10" stroke="#38BDF8" strokeWidth="1.6" strokeLinecap="round" />
      {/* Ingress Downward Arrows */}
      <path d="M24 33v5m-3-2l3 3 3-3" stroke="#38BDF8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── AWS API Gateway / API Gateway V2 ─────────────────────────────────────────
export function AwsApiGatewayIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#8C4FFF" />
      {/* API Gateway curly brackets / gateway routes */}
      <path
        d="M17 14c-2 0-3 1-3 3v4c0 2-1 3-3 3 2 0 3 1 3 3v4c0 2 1 3 3 3"
        stroke="#FFFFFF"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M31 14c2 0 3 1 3 3v4c0 2 1 3 3 3-2 0-3 1-3 3v4c0 2-1 3-3 3"
        stroke="#FFFFFF"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="18" r="2.5" fill="#FFFFFF" />
      <circle cx="24" cy="24" r="2.5" fill="#FFFFFF" />
      <circle cx="24" cy="30" r="2.5" fill="#FFFFFF" />
      <path d="M24 20.5v1M24 26.5v1" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ─── AWS DocumentDB ───────────────────────────────────────────────────────────
export function AwsDocdbIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#2E3899" />
      {/* Database cylinder */}
      <ellipse cx="24" cy="15" rx="11" ry="4" fill="#3B48CC" stroke="#FFFFFF" strokeWidth="2" />
      <path d="M13 15v17c0 2.2 4.9 4 11 4s11-1.8 11-4V15" stroke="#FFFFFF" strokeWidth="2" fill="none" />
      <path d="M13 23c0 2.2 4.9 4 11 4s11-1.8 11-4" stroke="#FFFFFF" strokeWidth="1.8" fill="none" />
      {/* Document overlay symbol */}
      <rect x="23" y="19" width="11" height="14" rx="1.5" fill="#FFFFFF" />
      <line x1="26" y1="23" x2="31" y2="23" stroke="#2E3899" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="26" y1="26" x2="31" y2="26" stroke="#2E3899" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="26" y1="29" x2="29" y2="29" stroke="#2E3899" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// ─── AWS Secrets Manager ──────────────────────────────────────────────────────
export function AwsSecretsManagerIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#DC2626" />
      {/* Keyhole and target vault */}
      <circle cx="24" cy="24" r="14" stroke="#FFFFFF" strokeWidth="2" strokeDasharray="3 3" fill="none" />
      <rect x="18" y="21" width="12" height="10" rx="2" fill="#FFFFFF" />
      <path d="M21 21v-3a3 3 0 016 0v3" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" fill="none" />
      <circle cx="24" cy="25" r="1.5" fill="#DC2626" />
      <path d="M24 26.5v2" stroke="#DC2626" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── Client / Desktop PC ──────────────────────────────────────────────────────
export function AwsClientIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#F8FAFC" stroke="#94A3B8" strokeWidth="1.5" />
      {/* Computer monitor */}
      <rect x="11" y="11" width="26" height="19" rx="2" fill="#1E293B" stroke="#0F172A" strokeWidth="1.5" />
      <rect x="14" y="14" width="20" height="13" rx="1" fill="#38BDF8" fillOpacity="0.8" />
      <line x1="16" y1="18" x2="23" y2="18" stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="16" y1="21" x2="28" y2="21" stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="16" y1="24" x2="20" y2="24" stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round" />
      {/* Stand and base */}
      <path d="M22 30v4h4v-4" stroke="#0F172A" strokeWidth="2" fill="none" />
      <rect x="17" y="34" width="14" height="2.5" rx="1" fill="#0F172A" />
    </svg>
  );
}

// ─── AWS SNS (Simple Notification Service) ────────────────────────────────────
export function AwsSnsIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#E11D48" />
      {/* Pub/Sub broadcast waves */}
      <circle cx="18" cy="24" r="4" fill="#FFFFFF" />
      <path d="M24 18c3.3 2 5.5 5.5 5.5 9.5s-2.2 7.5-5.5 9.5" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <path d="M28 13c5.5 3 9 8.5 9 14.5s-3.5 11.5-9 14.5" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

// ─── AWS EventBridge ──────────────────────────────────────────────────────────
export function AwsEventBridgeIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#FF4F8B" />
      {/* Central event hub with radiating nodes */}
      <circle cx="24" cy="24" r="5" fill="#FFFFFF" />
      <circle cx="13" cy="16" r="3" fill="#FFFFFF" />
      <circle cx="35" cy="16" r="3" fill="#FFFFFF" />
      <circle cx="13" cy="32" r="3" fill="#FFFFFF" />
      <circle cx="35" cy="32" r="3" fill="#FFFFFF" />
      <path d="M15.5 17.5l6 4.5M32.5 17.5l-6 4.5M15.5 30.5l6-4.5M32.5 30.5l-6-4.5" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ─── AWS Cognito ──────────────────────────────────────────────────────────────
export function AwsCognitoIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#DC2626" />
      {/* User profile with security checkmark */}
      <circle cx="24" cy="18" r="5" fill="#FFFFFF" />
      <path d="M15 32c0-5 4-8 9-8s9 3 9 8" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <path d="M30 26l3 3 6-6" stroke="#FEF08A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── AWS Step Functions ───────────────────────────────────────────────────────
export function AwsStepFunctionsIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#C925D1" />
      {/* State machine nodes */}
      <rect x="13" y="13" width="8" height="8" rx="2" fill="#FFFFFF" />
      <rect x="27" y="20" width="8" height="8" rx="2" fill="#FFFFFF" />
      <rect x="13" y="27" width="8" height="8" rx="2" fill="#FFFFFF" />
      <path d="M21 17h3v6h3M21 31h3v-4" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

