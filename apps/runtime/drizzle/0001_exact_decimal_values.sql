ALTER TABLE "claim" ALTER COLUMN "value_decimal" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "financial_fact" ALTER COLUMN "value" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "replacement_proposal" ALTER COLUMN "value" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "verification_attestation" ALTER COLUMN "independent_value" SET DATA TYPE numeric;