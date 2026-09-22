import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  color?: string;
}

// ─── Azure Provider Logo ──────────────────────────────────────────────────────
export function AzureIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.15" />
      <path
        d="M26.4 8.5h-8.8L8 31.2l6.2 8.3h14.7L26.4 8.5z"
        fill="#0078D4"
      />
      <path
        d="M26.4 8.5l-5.6 15.3 11 11.2L40 31.2 26.4 8.5z"
        fill="#5EA0EF"
      />
      <path
        d="M17.6 23.8L8 31.2l6.2 8.3h6.8l3.6-7.8-7-7.9z"
        fill="#005A9E"
      />
    </svg>
  );
}

// ─── Azure Resource Group ─────────────────────────────────────────────────────
export function AzureResourceGroupIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#8C4FFF" fillOpacity="0.15" />
      <rect x="8" y="8" width="14" height="14" rx="2" stroke="#8C4FFF" strokeWidth="2.5" fill="#8C4FFF" fillOpacity="0.3" />
      <rect x="26" y="8" width="14" height="14" rx="2" stroke="#8C4FFF" strokeWidth="2.5" fill="#8C4FFF" fillOpacity="0.3" />
      <rect x="8" y="26" width="14" height="14" rx="2" stroke="#8C4FFF" strokeWidth="2.5" fill="#8C4FFF" fillOpacity="0.3" />
      <rect x="26" y="26" width="14" height="14" rx="2" stroke="#8C4FFF" strokeWidth="2.5" fill="#8C4FFF" fillOpacity="0.3" />
      <path d="M15 22v4M33 22v4M22 15h4M22 33h4" stroke="#8C4FFF" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ─── Azure Virtual Network (VNet) ────────────────────────────────────────────
export function AzureVnetIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.15" />
      <rect x="7" y="7" width="34" height="34" rx="6" stroke="#0078D4" strokeWidth="2.5" strokeDasharray="3 3" />
      <circle cx="15" cy="15" r="4" fill="#0078D4" />
      <circle cx="33" cy="15" r="4" fill="#0078D4" />
      <circle cx="15" cy="33" r="4" fill="#0078D4" />
      <circle cx="33" cy="33" r="4" fill="#0078D4" />
      <path d="M15 19v10M33 19v10M19 15h10M19 33h10M18 18l12 12" stroke="#0078D4" strokeWidth="1.8" />
    </svg>
  );
}

// ─── Azure Subnet ─────────────────────────────────────────────────────────────
export function AzureSubnetIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#059669" fillOpacity="0.15" />
      <rect x="7" y="7" width="34" height="34" rx="5" stroke="#059669" strokeWidth="2" strokeDasharray="4 3" />
      <rect x="13" y="14" width="10" height="8" rx="2" fill="#059669" />
      <rect x="25" y="14" width="10" height="8" rx="2" fill="#059669" />
      <path d="M18 22v5h12v-5" stroke="#059669" strokeWidth="2" fill="none" />
      <circle cx="24" cy="33" r="3" fill="#059669" />
    </svg>
  );
}

// ─── Azure Virtual Machine (VM) ──────────────────────────────────────────────
export function AzureVmIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.18" />
      <path d="M24 7l15 8v18l-15 8-15-8V15l15-8z" fill="#0078D4" />
      <path d="M24 7l15 8-15 8-15-8 15-8z" fill="#5EA0EF" />
      <path d="M9 15l15 8v18l-15-8V15z" fill="#005A9E" />
      {/* VM computer window */}
      <rect x="18" y="22" width="12" height="9" rx="1.5" fill="#FFF" />
      <rect x="20" y="24" width="8" height="5" fill="#0078D4" />
    </svg>
  );
}

// ─── Azure Load Balancer ──────────────────────────────────────────────────────
export function AzureLbIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.15" />
      <circle cx="24" cy="14" r="5" fill="#0078D4" />
      <circle cx="14" cy="33" r="4.5" fill="#0078D4" />
      <circle cx="34" cy="33" r="4.5" fill="#0078D4" />
      <path d="M24 19v6m0 0l-9 4m9-4l9 4" stroke="#0078D4" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M21 14h6M24 11v6" stroke="#FFF" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── Azure Application Gateway ────────────────────────────────────────────────
export function AzureAppGatewayIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.15" />
      <rect x="9" y="11" width="30" height="26" rx="4" stroke="#0078D4" strokeWidth="2.5" fill="none" />
      <path d="M9 20h30" stroke="#0078D4" strokeWidth="2" />
      <circle cx="15" cy="15.5" r="2" fill="#0078D4" />
      <circle cx="21" cy="15.5" r="2" fill="#0078D4" />
      <path d="M18 28l6-4 6 4" stroke="#0078D4" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Azure SQL Database ───────────────────────────────────────────────────────
export function AzureSqlIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.18" />
      <path d="M12 13c0-3.3 5.4-6 12-6s12 2.7 12 6v22c0 3.3-5.4 6-12 6s-12-2.7-12-6V13z" fill="#0078D4" />
      <ellipse cx="24" cy="13" rx="12" ry="5" fill="#5EA0EF" />
      <path d="M12 21c0 2.8 5.4 5 12 5s12-2.2 12-5" stroke="#004C87" strokeWidth="2" fill="none" />
      <path d="M12 29c0 2.8 5.4 5 12 5s12-2.2 12-5" stroke="#004C87" strokeWidth="2" fill="none" />
    </svg>
  );
}

// ─── Azure Storage Account ────────────────────────────────────────────────────
export function AzureStorageIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.15" />
      <rect x="9" y="10" width="30" height="28" rx="3" stroke="#0078D4" strokeWidth="2.5" fill="#0078D4" fillOpacity="0.2" />
      <path d="M9 19h30M9 28h30" stroke="#0078D4" strokeWidth="2" />
      <rect x="21" y="14" width="6" height="2" rx="1" fill="#0078D4" />
      <rect x="21" y="23" width="6" height="2" rx="1" fill="#0078D4" />
      <rect x="21" y="32" width="6" height="2" rx="1" fill="#0078D4" />
    </svg>
  );
}

// ─── Azure Key Vault ──────────────────────────────────────────────────────────
export function AzureKeyVaultIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.15" />
      <circle cx="21" cy="22" r="8" stroke="#0078D4" strokeWidth="3" fill="#FFF" />
      <path d="M28 24l11 1v4l-3 1v3l-3 1v-3l-2-1" stroke="#0078D4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="20" cy="21" r="3" fill="#0078D4" />
    </svg>
  );
}

// ─── Azure Functions ──────────────────────────────────────────────────────────
export function AzureFunctionsIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.15" />
      <path d="M14 18l-5 6 5 6" stroke="#0078D4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M34 18l5 6-5 6" stroke="#0078D4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* Lightning bolt */}
      <path d="M26 12l-6 11h5l-3 13 8-14h-5l4-10z" fill="#FFB900" />
    </svg>
  );
}

// ─── Azure AKS (Kubernetes) ───────────────────────────────────────────────────
export function AzureAksIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.15" />
      <circle cx="24" cy="24" r="14" stroke="#0078D4" strokeWidth="2.5" fill="#0078D4" fillOpacity="0.1" />
      <circle cx="24" cy="24" r="5" fill="#0078D4" />
      <path d="M24 10v6M24 32v6M10 24h6M32 24h6M14 14l4 4M30 30l4 4M14 34l4-4M30 18l4-4" stroke="#0078D4" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ─── Azure Public IP ──────────────────────────────────────────────────────────
export function AzurePublicIpIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.15" />
      <circle cx="24" cy="24" r="13" stroke="#0078D4" strokeWidth="2.2" fill="none" />
      <path d="M11 24h26M24 11v26" stroke="#0078D4" strokeWidth="1.8" />
      <path d="M14 18c3-4 7-6 10-6s7 2 10 6M14 30c3 4 7 6 10 6s7-2 10-6" stroke="#0078D4" strokeWidth="1.8" />
    </svg>
  );
}

// ─── Azure NSG ────────────────────────────────────────────────────────────────
export function AzureNsgIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.18" />
      <path
        d="M24 7l13 4v11c0 9-5.5 15-13 18-7.5-3-13-9-13-18V11l13-4z"
        stroke="#0078D4"
        strokeWidth="2.5"
        fill="#0078D4"
        fillOpacity="0.25"
      />
      <path d="M19 19h10M16 24h16M19 29h10" stroke="#0078D4" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ─── Azure Network Interface (NIC) ────────────────────────────────────────────
export function AzureNicIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.15" />
      <rect x="10" y="14" width="28" height="20" rx="3" stroke="#0078D4" strokeWidth="2.5" fill="#0078D4" fillOpacity="0.2" />
      <rect x="15" y="19" width="10" height="10" rx="1.5" stroke="#0078D4" strokeWidth="1.8" fill="#FFF" />
      <path d="M30 19v10M33 21v6" stroke="#0078D4" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ─── Azure App Service ────────────────────────────────────────────────────────
export function AzureAppServiceIcon({ size = 24, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className}>
      <rect width="48" height="48" rx="8" fill="#0078D4" fillOpacity="0.15" />
      <circle cx="24" cy="24" r="13" stroke="#0078D4" strokeWidth="2.5" fill="#0078D4" fillOpacity="0.15" />
      <path d="M11 24h26M24 11c4 3.5 6 8 6 13s-2 9.5-6 13c-4-3.5-6-8-6-13s2-9.5 6-13z" stroke="#0078D4" strokeWidth="1.8" fill="none" />
    </svg>
  );
}
