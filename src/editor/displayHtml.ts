import { attachmentDisplayUrl } from '../vendor/plan-a-work/utils/richImage';

/**
 * 읽기 화면용 — 저장 HTML 의 attachment://<id> 를 처음부터 화면 주소로 바꿔 그린다.
 * (WebView 가 attachment:// 를 직접 읽으려다 실패하는 순간을 없앤다. 저장 HTML 은 그대로다.)
 */
export function withDisplayImageUrls(html: string): string {
  return html.replace(/src=(["'])attachment:\/\/([0-9a-f-]{36})\1/gi, (_match, quote: string, id: string) => `src=${quote}${attachmentDisplayUrl(id)}${quote}`);
}
