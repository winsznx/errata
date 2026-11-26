import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { ENV } from "../config/env.js";
import * as schema from "./schema.js";

export const sqlClient = postgres(ENV.DATABASE_URL, { max: 20, onnotice: () => undefined });
export const db = drizzle(sqlClient, { schema, casing: "snake_case" });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;
