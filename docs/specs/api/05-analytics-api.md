# 5. Analytics API Endpoint

This document provides the specification for the Analytics API endpoint, which is responsible for serving aggregated financial data for use in frontend reporting and visualizations.

- **Endpoint**: `/api/analytics`
- **Method**: `GET`

## 5.1. General Principles

The Analytics API provides a flexible way to query pre-aggregated financial data. It reads from the `AnalyticsCacheMonthly` table, which contains data that has been processed and summarized by the backend worker. This ensures that API responses are fast and that complex calculations are not performed on the fly.

The API supports filtering by time, geography, and category, and it returns data in a nested structure that is easy for the frontend to consume.

## 5.2. Authentication and Authorization

- **Authentication**: All requests to this endpoint must be authenticated using a JWT token provided in the `Authorization` header (`Bearer <token>`).
- **Authorization**: The endpoint is tenant-aware and will only return data associated with the authenticated user's `tenantId`.

## 5.3. Query Parameters

The `GET /api/analytics` endpoint accepts the following query parameters:

| Parameter      | Type     | Description                                                                                             | Default   |
|----------------|----------|---------------------------------------------------------------------------------------------------------|-----------|
| `view`         | `string` | The time-based view for the data. Can be `year`, `quarter`, or `month`.                                   | `year`    |
| `currency`     | `string` | The currency for the financial data.                                                                    | `USD`     |
| `countries[]`  | `string` | An array of country codes to filter the data.                                                           | `[]`      |
| `years[]`      | `number` | An array of years to include in the response (only used when `view` is `year`).                             | `[]`      |
| `startMonth`   | `string` | The start month in `YYYY-MM` format (only used when `view` is `month`).                                     |           |
| `endMonth`     | `string` | The end month in `YYYY-MM` format (only used when `view` is `month`).                                       |           |
| `startQuarter` | `string` | The start quarter in `YYYY-Q#` format (e.g., `2023-Q1`) (only used when `view` is `quarter`).             |           |
| `endQuarter`   | `string` | The end quarter in `YYYY-Q#` format (e.g., `2023-Q4`) (only used when `view` is `quarter`).               |           |
| `types[]`      | `string` | An array of category types to filter by (e.g., `Expense`, `Income`).                                        | `[]`      |
| `groups[]`     | `string` | An array of category groups to filter by.                                                               | `[]`      |

## 5.4. Response Format

The API returns a JSON object with the requested `currency`, `view`, and a `data` object containing the results. The `data` object is keyed by the time period (`year`, `quarter`, or `month`), and each period contains a nested structure of types and groups.

### Example Response (`view=year`)

```json
{
  "currency": "USD",
  "view": "year",
  "data": {
    "2023": {
      "Expense": {
        "Groceries": {
          "credit": 0,
          "debit": 5000,
          "balance": -5000
        },
        "Transport": {
          "credit": 0,
          "debit": 1200,
          "balance": -1200
        }
      },
      "Income": {
        "Salary": {
          "credit": 60000,
          "debit": 0,
          "balance": 60000
        }
      }
    }
  }
}
```
