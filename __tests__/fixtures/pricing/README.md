# Pricing / FX response fixtures

These files reproduce the **response shape** of the official APIs CloudCraft calls, so
adapter tests are deterministic and never touch the network:

| File | API | Shape reference |
|---|---|---|
| `azure-retail-vm-b2s-eastus.json` | Azure Retail Prices API (`prices.azure.com/api/retail/prices`) | `BillingCurrency`, `Items[]` (`retailPrice`, `armSkuName`, `meterName`, `productName`, …), `NextPageLink`, `Count` |
| `open-er-api-usd.json` | open.er-api.com `v6/latest/USD` | `result`, `base_code`, `time_last_update_utc`, `time_next_update_utc`, `rates{}` |
| `frankfurter-usd-eur.json` | Frankfurter `v1/latest?base=USD&symbols=EUR` | `amount`, `base`, `date`, `rates{}` |

The numbers are **illustrative fixtures**, not current prices or rates. Live values are
exercised only by `npm run test:live`.
