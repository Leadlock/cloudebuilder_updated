import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  color?: string;
}

export function GcpIcon({ size = 24, className = '', color = '#4285F4' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} className={className}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
      <path d="M12 6c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 10c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4z"/>
    </svg>
  );
}

// Re-use the same shape as a generic icon for other GCP services for now
export const GcpComputeIcon = GcpIcon;
export const GcpStorageIcon = GcpIcon;
export const GcpDatabaseIcon = GcpIcon;
export const GcpNetworkIcon = GcpIcon;
export const GcpSecurityIcon = GcpIcon;
export const GcpServerlessIcon = GcpIcon;
