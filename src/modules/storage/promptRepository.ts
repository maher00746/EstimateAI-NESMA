import { PromptDocument, PromptModel } from "./promptModel";

export async function getPromptByKey(key: string): Promise<PromptDocument | null> {
  return PromptModel.findOne({ key }).exec();
}

export async function upsertPrompt(key: string, content: string): Promise<PromptDocument> {
  const existing = await PromptModel.findOneAndUpdate(
    { key },
    { content },
    { new: true }
  ).exec();

  if (existing) return existing;

  const prompt = new PromptModel({ key, content });
  return prompt.save();
}


