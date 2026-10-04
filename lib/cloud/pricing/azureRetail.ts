/** Azure Retail Prices API row shape and unit handling, shared by the live provider and the AI meter picker. */
export interface AzureRetailPriceItem {
  currencyCode: string;
  tierMinimumUnits: number;
  retailPrice: number;
  unitPrice: number;
  armRegionName: string;
  location: string;
  effectiveStartDate: string;
  meterId: string;
  meterName: string;
  productId: string;
  skuId: string;
  productName: string;
  skuName: string;
  serviceName: string;
  serviceId: string;
  serviceFamily: string;
  unitOfMeasure: string;
  type: string;
  isPrimaryMeterRegion?: boolean;
  armSkuName?: string;
}

export const HOURS_PER_MONTH = 730;

/**
 * The Retail Prices API quotes each meter in its own unit ("1 Hour", "1/Hour", "1/Day", "1/Month", "1 GB/Month", ...).
 * Treating every retailPrice as per-hour made SQL Database (billed per DAY) look 24x too expensive, so every conversion goes through here.
 * Returns null for a unit that is not a time-based charge, so the caller never multiplies a per-GB or per-request price by hours.
 */
export function monthlyFromRetailItem(item: Pick<AzureRetailPriceItem, 'retailPrice' | 'unitOfMeasure'>): number | null {
  const unit = (item.unitOfMeasure || '').trim().toLowerCase();
  if (/\bgb\b|\b\d*k\b|request|operation/.test(unit)) return null;
  if (/hour/.test(unit)) return item.retailPrice * HOURS_PER_MONTH;
  if (/day/.test(unit)) return item.retailPrice * (HOURS_PER_MONTH / 24);
  if (/month/.test(unit)) return item.retailPrice;
  return null;
}
