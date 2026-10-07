import { describe, expect, it } from 'vitest';
import { attachmentIdFromUrl, normalizeImagesInRoot, serializeRichHtml } from '../vendor/plan-a-work/utils/richImage';
import { sanitizeTaskDescriptionHtml } from '../vendor/plan-a-work/utils/taskDescription';

const ID = '6f1c2b9e-1111-4222-8333-944455556666';

describe('Desktop 이미지 참조(attachment://)', () => {
  it('화면에는 custom protocol 주소, 저장에는 attachment:// 만 남는다', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p>보고서</p><img src="attachment://${ID}">`;
    normalizeImagesInRoot(root);
    const img = root.querySelector('img')!;
    // Windows WebView2: http://attachment.localhost/<id> · 그 밖: attachment://localhost/<id>
    const shown = img.getAttribute('src')!;
    expect(shown).not.toBe(`attachment://${ID}`);
    expect(shown).toMatch(/attachment(\.localhost|:\/\/localhost)\//);
    expect(attachmentIdFromUrl(shown)).toBe(ID);
    const saved = serializeRichHtml(root);
    expect(saved).toContain(`src="attachment://${ID}"`);
    expect(saved).not.toContain('localhost');
    expect(saved).not.toContain('data-canonical-src');
  });

  it('sanitizer 는 attachment:// 를 남기고 로컬 경로·Base64 는 지운다', () => {
    const { html } = sanitizeTaskDescriptionHtml(
      `<img src="attachment://${ID}"><img src="file:///C:/Users/me/a.png"><img src="data:image/png;base64,AAAA"><b>굵게</b>`,
    );
    expect(html).toContain(`attachment://${ID}`);
    expect(html).not.toContain('file:');
    expect(html).not.toContain('base64');
    expect(html).toContain('굵게');
  });

  it('화면 주소가 섞여 들어와도 같은 id 로 본다', () => {
    expect(attachmentIdFromUrl(`http://attachment.localhost/${ID}`)).toBe(ID);
    expect(attachmentIdFromUrl(`attachment://${ID}`)).toBe(ID);
    expect(attachmentIdFromUrl('https://example.com/a.png')).toBeNull();
  });
});

describe('withDisplayImageUrls', () => {
  it('읽기 화면 HTML 만 화면 주소로 바꾼다', async () => {
    const { withDisplayImageUrls } = await import('../editor/displayHtml');
    const html = `<p>a</p><img src="attachment://${ID}" alt="">`;
    const shown = withDisplayImageUrls(html);
    expect(shown).not.toContain(`src="attachment://${ID}"`);
    expect(attachmentIdFromUrl(shown.match(/src="([^"]+)"/)![1])).toBe(ID);
  });
});

describe('storedHtmlForDisplay (편집기에 넣기 전)', () => {
  it('innerHTML 에 attachment:// 가 한 번도 들어가지 않고, 저장하면 원래 HTML 로 돌아온다', async () => {
    const { storedHtmlForDisplay } = await import('../vendor/plan-a-work/utils/richImage');
    const stored = `<p>보고서</p><img src="attachment://${ID}" alt="그림"><p>끝</p>`;
    const display = storedHtmlForDisplay(stored);
    expect(display).not.toContain(` src="attachment://${ID}"`); // 저장 주소 그대로는 넣지 않는다
    expect(display).toContain(`data-canonical-src="attachment://${ID}"`);
    const root = document.createElement('div');
    root.innerHTML = display;
    normalizeImagesInRoot(root);
    expect(serializeRichHtml(root)).toBe(stored);
    // 이미지가 없거나 외부 주소면 그대로
    expect(storedHtmlForDisplay('<p>글</p><img src="https://a.example/x.png">')).toBe('<p>글</p><img src="https://a.example/x.png">');
  });
});
