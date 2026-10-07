import { descriptionToPreviewText } from '../vendor/plan-a-work/utils/richImage';

/** HTML → 한 줄 미리보기(드래그 표시·목록 등 화면용). 검색용 평문은 Rust 가 저장 시 만든다. */
export function textOf(html: string): string {
  return descriptionToPreviewText(html);
}
