import { PricingModel } from "./pricingModel";

export type PricingPayload = {
  percentage: string;
  idleText: string;
  poRate: string;
  mpHourlyRate: string;
  subItemsByItemId: Record<string, unknown>;
  autoRowQtyByItemId: Record<string, unknown>;
  qtyOverrideByItemId?: Record<string, unknown>;
  collapsedByItemId?: Record<string, unknown>;
  completedByItemId?: Record<string, unknown>;
  blockCodeByItemId?: Record<string, unknown>;
};

export async function getPricing(userId: string, projectId: string) {
  return PricingModel.findOne({ userId, projectId }).exec();
}

export async function upsertPricing(userId: string, projectId: string, payload: PricingPayload) {
  return PricingModel.findOneAndUpdate(
    { userId, projectId },
    {
      $set: {
        percentage: payload.percentage ?? "10",
        idleText: payload.idleText ?? "idle time",
        poRate: payload.poRate ?? "8",
        mpHourlyRate: payload.mpHourlyRate ?? "0",
        subItemsByItemId: payload.subItemsByItemId ?? {},
        autoRowQtyByItemId: payload.autoRowQtyByItemId ?? {},
        qtyOverrideByItemId: payload.qtyOverrideByItemId ?? {},
        collapsedByItemId: payload.collapsedByItemId ?? {},
        completedByItemId: payload.completedByItemId ?? {},
        blockCodeByItemId: payload.blockCodeByItemId ?? {},
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).exec();
}
