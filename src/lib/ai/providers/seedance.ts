import type { VideoProvider, VideoGenerateParams } from "../types";
import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";

function toDataUrl(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "png"
        ? "image/png"
        : ext === "webp"
          ? "image/webp"
          : "image/png";
  const base64 = fs.readFileSync(filePath, { encoding: "base64" });
  return `data:${mime};base64,${base64}`;
}

export class SeedanceProvider implements VideoProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private referenceModel: string;
  private uploadDir: string;

  constructor(params?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    referenceModel?: string;
    uploadDir?: string;
  }) {
    this.apiKey = params?.apiKey || process.env.SEEDANCE_API_KEY || "";
    this.baseUrl = (
      params?.baseUrl ||
      process.env.SEEDANCE_BASE_URL ||
      "https://ark.cn-beijing.volces.com/api/v3"
    ).replace(/\/+$/, "");
    this.model =
      params?.model || process.env.SEEDANCE_MODEL || "doubao-seedance-1-5-pro-250528";
    this.referenceModel =
      params?.referenceModel ||
      process.env.SEEDANCE_REFERENCE_MODEL ||
      "doubao-seedance-1-0-lite-i2v-250428";
    this.uploadDir =
      params?.uploadDir || process.env.UPLOAD_DIR || "./uploads";
  }

  async generateVideo(params: VideoGenerateParams): Promise<string> {
    const body = "firstFrame" in params
      ? this.buildKeyframeBody(params as VideoGenerateParams & { firstFrame: string; lastFrame: string })
      : this.buildReferenceBody(params as VideoGenerateParams & { charRefImages: string[] });

    console.log(
      `[Seedance] Submitting task: model=${body.model}, duration=${body.duration}, ratio=${body.ratio}`
    );

    const submitResponse = await fetch(
      `${this.baseUrl}/contents/generations/tasks`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      }
    );

    if (!submitResponse.ok) {
      const errText = await submitResponse.text();
      throw new Error(
        `Seedance submit failed: ${submitResponse.status} ${errText}`
      );
    }

    const submitResult = (await submitResponse.json()) as { id: string };
    console.log(`[Seedance] Task submitted: ${submitResult.id}`);

    const videoUrl = await this.pollForResult(submitResult.id);

    const videoResponse = await fetch(videoUrl);
    const buffer = Buffer.from(await videoResponse.arrayBuffer());
    const filename = `${ulid()}.mp4`;
    const dir = path.join(this.uploadDir, "videos");
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, buffer);

    return filepath;
  }

  private buildKeyframeBody(params: VideoGenerateParams & { firstFrame: string; lastFrame: string }): Record<string, unknown> {
    const firstFrameUrl = toDataUrl(params.firstFrame);
    const lastFrameUrl = toDataUrl(params.lastFrame);

    return {
      model: this.model,
      content: [
        { type: "text", text: params.prompt },
        { type: "image_url", image_url: { url: firstFrameUrl }, role: "first_frame" },
        { type: "image_url", image_url: { url: lastFrameUrl }, role: "last_frame" },
      ],
      duration: params.duration || 5,
      ratio: params.ratio || "16:9",
      watermark: false,
    };
  }

  private buildReferenceBody(params: VideoGenerateParams & { charRefImages: string[] }): Record<string, unknown> {
    // Prepend [图N] references to prompt so the model knows which image is which
    const imageRefs = params.charRefImages.map((_, i) => `[图${i + 1}]`).join("");
    const textWithRefs = `${imageRefs}${params.prompt}`;

    return {
      model: this.referenceModel,
      content: [
        { type: "text", text: textWithRefs },
        ...params.charRefImages.map((imgPath) => ({
          type: "image_url",
          image_url: { url: toDataUrl(imgPath) },
          role: "reference_image",
        })),
      ],
      duration: params.duration || 5,
      ratio: params.ratio || "16:9",
      watermark: false,
    };
  }

  private async pollForResult(taskId: string): Promise<string> {
    const maxAttempts = 120;
    const interval = 5000;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, interval));

      const response = await fetch(
        `${this.baseUrl}/contents/generations/tasks/${taskId}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        }
      );

      if (!response.ok) continue;

      const result = (await response.json()) as {
        status: string;
        content?: { video_url?: string };
        error?: { message?: string };
      };

      console.log(`[Seedance] Poll ${i + 1}: status=${result.status}`);

      if (result.status === "succeeded" && result.content?.video_url) {
        return result.content.video_url;
      }
      if (result.status === "failed") {
        throw new Error(
          `Seedance generation failed: ${result.error?.message || "unknown"}`
        );
      }
    }

    throw new Error("Seedance generation timed out after 10 minutes");
  }
}
