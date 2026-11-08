const mongoose = require('mongoose');
const AppError = require('../utils/app-error');
const { AUDIT_EVENTS } = require('../constants/audit.constants');
const { DEFAULT_CATEGORIES } = require('../constants/asset.constants');
const Asset = require('../models/Asset');
const AssetCategory = require('../models/AssetCategory');
const AssetVendor = require('../models/AssetVendor');
const { logAudit } = require('./audit.service');

const COLLATION = { locale: 'en', strength: 2 };
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const audit = (actor, req, action, entityType, entity, metadata = {}) =>
  logAudit({
    action, entityId: entity._id.toString(), entityType, metadata: { name: entity.name, ...metadata },
    organizationId: actor.organization, req, userId: actor._id,
  });

function assertId(id, label) {
  if (!mongoose.isValidObjectId(id)) throw new AppError(`${label} not found`, 404, 'NOT_FOUND');
}

// ---- categories ------------------------------------------------------------

/**
 * Seeds the standard categories the first time an organization uses assets (idempotent, race-safe thanks to the
 * unique name index). No hook into organization creation is needed.
 */
async function ensureDefaultCategories(organization) {
  const existing = await AssetCategory.countDocuments({ organization });
  if (existing > 0) return;
  await Promise.all(
    DEFAULT_CATEGORIES.map((name) =>
      AssetCategory.updateOne({ organization, name }, { $setOnInsert: { organization, name, isDefault: true } }, { upsert: true, collation: COLLATION })
        .catch((error) => { if (error.code !== 11000) throw error; })),
  );
}

async function listCategories({ actor, includeArchived = false }) {
  await ensureDefaultCategories(actor.organization);
  const filter = { organization: actor.organization, ...(includeArchived ? {} : { archivedAt: null }) };
  const [categories, counts] = await Promise.all([
    AssetCategory.find(filter).collation(COLLATION).sort({ name: 1 }).lean(),
    Asset.aggregate([
      { $match: { organization: actor.organization, deletedAt: null } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]),
  ]);
  const byCategory = new Map(counts.map((row) => [row._id.toString(), row.count]));
  return {
    categories: categories.map((category) => ({
      id: category._id.toString(), name: category.name, description: category.description, isDefault: category.isDefault,
      archived: Boolean(category.archivedAt), assetCount: byCategory.get(category._id.toString()) || 0,
    })),
  };
}

async function createCategory({ actor, body, req }) {
  try {
    const category = await AssetCategory.create({ organization: actor.organization, name: body.name, description: body.description || '', createdBy: actor._id });
    await audit(actor, req, AUDIT_EVENTS.ASSET_CATEGORY_CREATED, 'asset_category', category);
    return { category: { id: category._id.toString(), name: category.name, description: category.description, assetCount: 0, archived: false } };
  } catch (error) {
    if (error.code === 11000) throw new AppError('A category with this name already exists', 409, 'DUPLICATE_CATEGORY');
    throw error;
  }
}

async function findCategory(id, organization) {
  assertId(id, 'Category');
  const category = await AssetCategory.findOne({ _id: id, organization });
  if (!category) throw new AppError('Category not found', 404, 'NOT_FOUND');
  return category;
}

async function updateCategory({ actor, id, body, req }) {
  const category = await findCategory(id, actor.organization);
  const from = category.name;
  if (body.name !== undefined) category.name = body.name;
  if (body.description !== undefined) category.description = body.description;
  try {
    await category.save();
  } catch (error) {
    if (error.code === 11000) throw new AppError('A category with this name already exists', 409, 'DUPLICATE_CATEGORY');
    throw error;
  }
  await audit(actor, req, AUDIT_EVENTS.ASSET_CATEGORY_UPDATED, 'asset_category', category, { from });
  return { category: { id: category._id.toString(), name: category.name, description: category.description } };
}

/**
 * Archiving hides a category from new assets. If assets still use it the caller must say where they go
 * (`moveTo`), otherwise the request is refused — assets are never orphaned or silently re-categorised.
 */
async function archiveCategory({ actor, id, moveTo, req }) {
  const category = await findCategory(id, actor.organization);
  if (category.archivedAt) return { success: true };

  const inUse = await Asset.countDocuments({ organization: actor.organization, category: category._id, deletedAt: null });
  if (inUse > 0) {
    if (!moveTo) {
      throw new AppError(`${inUse} asset${inUse === 1 ? ' is' : 's are'} still in this category. Choose a category to move them to.`, 409, 'CATEGORY_IN_USE', { assets: inUse });
    }
    const target = await findCategory(moveTo, actor.organization);
    if (target.archivedAt || target._id.equals(category._id)) throw new AppError('Choose an active category to move the assets to', 400, 'INVALID_TARGET_CATEGORY');
    await Asset.updateMany({ organization: actor.organization, category: category._id }, { $set: { category: target._id } });
  }
  category.archivedAt = new Date();
  await category.save();
  await audit(actor, req, AUDIT_EVENTS.ASSET_CATEGORY_ARCHIVED, 'asset_category', category, { moved: inUse, moveTo: moveTo || null });
  return { success: true, moved: inUse };
}

async function requireActiveCategory(id, organization) {
  assertId(id, 'Category');
  const category = await AssetCategory.findOne({ _id: id, organization, archivedAt: null }).lean();
  if (!category) throw new AppError('Category not found', 404, 'NOT_FOUND');
  return category;
}

// ---- vendors ----------------------------------------------------------------

const serializeVendor = (vendor, assetCount = 0) => ({
  id: vendor._id.toString(), name: vendor.name, contactPerson: vendor.contactPerson, email: vendor.email, phone: vendor.phone,
  address: vendor.address, website: vendor.website, notes: vendor.notes, archived: Boolean(vendor.archivedAt), assetCount,
});

async function listVendors({ actor, search, includeArchived = false }) {
  const filter = { organization: actor.organization, ...(includeArchived ? {} : { archivedAt: null }) };
  if (search) filter.name = new RegExp(escapeRegex(search), 'i');
  const [vendors, counts] = await Promise.all([
    AssetVendor.find(filter).collation(COLLATION).sort({ name: 1 }).limit(500).lean(),
    Asset.aggregate([
      { $match: { organization: actor.organization, deletedAt: null, 'purchase.vendor': { $ne: null } } },
      { $group: { _id: '$purchase.vendor', count: { $sum: 1 } } },
    ]),
  ]);
  const byVendor = new Map(counts.map((row) => [row._id.toString(), row.count]));
  return { vendors: vendors.map((vendor) => serializeVendor(vendor, byVendor.get(vendor._id.toString()) || 0)) };
}

async function createVendor({ actor, body, req }) {
  try {
    const vendor = await AssetVendor.create({ organization: actor.organization, ...body, createdBy: actor._id });
    await audit(actor, req, AUDIT_EVENTS.ASSET_VENDOR_CREATED, 'asset_vendor', vendor);
    return { vendor: serializeVendor(vendor) };
  } catch (error) {
    if (error.code === 11000) throw new AppError('A vendor with this name already exists', 409, 'DUPLICATE_VENDOR');
    throw error;
  }
}

async function findVendor(id, organization) {
  assertId(id, 'Vendor');
  const vendor = await AssetVendor.findOne({ _id: id, organization });
  if (!vendor) throw new AppError('Vendor not found', 404, 'NOT_FOUND');
  return vendor;
}

async function updateVendor({ actor, id, body, req }) {
  const vendor = await findVendor(id, actor.organization);
  Object.assign(vendor, body);
  try {
    await vendor.save();
  } catch (error) {
    if (error.code === 11000) throw new AppError('A vendor with this name already exists', 409, 'DUPLICATE_VENDOR');
    throw error;
  }
  await audit(actor, req, AUDIT_EVENTS.ASSET_VENDOR_UPDATED, 'asset_vendor', vendor);
  return { vendor: serializeVendor(vendor) };
}

/** Vendors referenced by assets are archived (kept for history), never deleted. */
async function archiveVendor({ actor, id, req }) {
  const vendor = await findVendor(id, actor.organization);
  vendor.archivedAt = vendor.archivedAt || new Date();
  await vendor.save();
  await audit(actor, req, AUDIT_EVENTS.ASSET_VENDOR_ARCHIVED, 'asset_vendor', vendor);
  return { success: true };
}

async function requireVendor(id, organization) {
  if (!id) return null;
  assertId(id, 'Vendor');
  const vendor = await AssetVendor.findOne({ _id: id, organization, archivedAt: null }).select('_id').lean();
  if (!vendor) throw new AppError('Vendor not found', 404, 'NOT_FOUND');
  return vendor;
}

module.exports = {
  archiveCategory, archiveVendor, createCategory, createVendor, ensureDefaultCategories, listCategories, listVendors,
  requireActiveCategory, requireVendor, updateCategory, updateVendor,
};
