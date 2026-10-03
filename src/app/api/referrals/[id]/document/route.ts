import { handle } from '@/lib/http';
import { getDocument } from '@/lib/service';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(req, async (ctx, actor) => {
    const doc = await getDocument(ctx, actor, (await params).id);
    return new Response(new Uint8Array(doc.bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${doc.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  });
}
