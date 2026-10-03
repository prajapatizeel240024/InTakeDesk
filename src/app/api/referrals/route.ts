import { handle, json } from '@/lib/http';
import { ServiceError, assertCan, listQueue, uploadReferral } from '@/lib/service';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(req: Request) {
  return handle(req, async (ctx, actor) => {
    const status = new URL(req.url).searchParams.get('status') ?? undefined;
    return json(await listQueue(ctx, actor, { status }));
  });
}

export async function POST(req: Request) {
  return handle(req, async (ctx, actor) => {
    // Check the role before reading a possibly large upload.
    await assertCan(ctx, actor, 'upload', 'upload');
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ServiceError('Send the PDF as multipart form data.', 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw new ServiceError('Attach a PDF in the "file" field.', 400);
    const result = await uploadReferral(ctx, actor, { filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
    return json(result, result.duplicate ? 200 : 201);
  });
}
