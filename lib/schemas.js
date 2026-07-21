const { z } = require('zod');

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Invalid request payload.",
        details: result.error.errors
      });
    }
    // Set validated payload on req.body for type safety
    req.body = result.data;
    next();
  };
}

const PublishSchema = z.object({
  listing: z.object({
    title: z.string().min(1, "Title is required"),
    description: z.string().optional().default(""),
    suggestedPrice: z.union([z.number(), z.string()]),
    categoryId: z.string().optional().default(""),
    brand: z.string().optional().default("Generic"),
    model: z.string().optional().default("Product"),
    condition: z.string().optional().default("NEW"),
    upc: z.string().optional().default("Does Not Apply"),
    aspects: z.record(z.any()).optional().default({})
  }).passthrough(),
  imageUrls: z.array(z.string()).nonempty("At least one image URL is required"),
  force: z.boolean().optional().default(false),
  sku: z.string().optional(),
  bestOfferEnabled: z.boolean().optional().default(false),
  autoAcceptPrice: z.union([z.number(), z.string(), z.null()]).optional(),
  autoDeclinePrice: z.union([z.number(), z.string(), z.null()]).optional(),
  promoteEnabled: z.boolean().optional().default(false),
  bidPercentage: z.union([z.number(), z.string(), z.null()]).optional(),
  crossPostShopify: z.boolean().optional().default(false),
  crossPostWooCommerce: z.boolean().optional().default(false),
  crossPostEtsy: z.boolean().optional().default(false)
});

const DraftAutosaveSchema = z.object({
  sku: z.string().min(1, "SKU is required"),
  listing: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    suggestedPrice: z.union([z.number(), z.string()]).optional(),
    categoryId: z.string().optional(),
    brand: z.string().optional(),
    model: z.string().optional(),
    condition: z.string().optional(),
    upc: z.string().optional(),
    aspects: z.record(z.any()).optional()
  }).passthrough().optional().default({}),
  imageUrls: z.array(z.string()).optional().default([])
});

const TemplateSchema = z.object({
  name: z.string().min(1, "Template name is required")
}).passthrough();

const RepricerSchema = z.object({
  sku: z.string().min(1, "SKU is required"),
  priceFloor: z.union([z.number(), z.string(), z.null()]).optional(),
  priceCap: z.union([z.number(), z.string(), z.null()]).optional(),
  priceLocked: z.boolean().optional()
});

const DlqActionSchema = z.object({
  action: z.enum(['retry', 'dismiss', 'dismiss_all']),
  sku: z.string().optional(),
  platform: z.string().optional()
});

const ConfigSaveSchema = z.record(z.string().nullable().optional());

const BillingCreateSessionSchema = z.object({
  priceId: z.string().optional(),
  lookupKey: z.string().optional()
});

const SaveDraftSchema = PublishSchema.extend({
  imageUrls: z.array(z.string()).optional().default([])
});

module.exports = {
  validate,
  PublishSchema,
  SaveDraftSchema,
  DraftAutosaveSchema,
  TemplateSchema,
  RepricerSchema,
  DlqActionSchema,
  ConfigSaveSchema,
  BillingCreateSessionSchema
};

