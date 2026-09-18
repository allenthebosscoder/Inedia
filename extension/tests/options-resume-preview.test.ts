import { describe, it, expect } from 'vitest';
import { dataUrlToBlob } from '../src/options/options';

describe('dataUrlToBlob', () => {
  it('decodes a base64 data URL into a Blob with the correct MIME type and byte content', async () => {
    // "fake" base64-encoded
    const dataUrl = 'data:application/pdf;base64,ZmFrZQ==';

    const blob = dataUrlToBlob(dataUrl);

    expect(blob.type).toBe('application/pdf');
    expect(await blob.text()).toBe('fake');
  });

  it('falls back to application/octet-stream when the MIME type is missing or unparseable', async () => {
    const dataUrl = 'data:;base64,ZmFrZQ==';

    const blob = dataUrlToBlob(dataUrl);

    expect(blob.type).toBe('application/octet-stream');
  });
});
