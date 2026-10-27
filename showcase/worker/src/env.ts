export type Env = {
  STATE: KVNamespace;
  ASSETS: Fetcher;
  DATABRICKS_HOST: string;
  DATABRICKS_WAREHOUSE_ID: string;
  CATALOG: string;
  DATABRICKS_TOKEN: string;
  REFRESH_TOKEN?: string;
};
