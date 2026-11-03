// The images attached to a question. One stays where a single image always
// was (`imageDataUrl`), so a message with one image is saved exactly as before
// and every reader of that field still finds it; only a question with several
// carries the list. Shared by the panel, the page and the ask route.

/** The most images one question carries. */
export const MAX_ATTACHED_IMAGES = 8;

type WithImages = { imageDataUrl?: string; imageDataUrls?: string[] };

/** Every image attached to a message, whichever way it was saved. */
export function messageImages(message: WithImages | null | undefined): string[] {
  if (!message) return [];
  if (Array.isArray(message.imageDataUrls) && message.imageDataUrls.length) return message.imageDataUrls;
  return message.imageDataUrl ? [message.imageDataUrl] : [];
}

/** The image fields for a message holding these images: none, one, or a list. */
export function imageFields(images: string[] | undefined): WithImages {
  if (!images?.length) return {};
  return images.length === 1 ? { imageDataUrl: images[0] } : { imageDataUrls: images };
}

const DATA_URL = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/;

/** An image data URL's type and bytes; null when it is not one. */
export function parseImageDataUrl(url: string): { mime: string; base64: string } | null {
  const match = DATA_URL.exec(url);
  return match ? { mime: match[1], base64: match[2] } : null;
}

/** The file extension for an image type, for a file a CLI is pointed at. */
export function imageExtension(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  const sub = mime.split("/")[1] ?? "png";
  return /^[a-z0-9]+$/.test(sub) ? sub : "png";
}

/**
 * The images a request carries, as data URLs: the list, or the single image
 * older clients send. Anything that is not an image data URL is dropped.
 */
export function requestImages(list: unknown, single?: unknown): string[] {
  const candidates = Array.isArray(list) ? list : single ? [single] : [];
  return candidates
    .filter((value): value is string => typeof value === "string" && !!parseImageDataUrl(value))
    .slice(0, MAX_ATTACHED_IMAGES);
}
