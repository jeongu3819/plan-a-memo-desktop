/**
 * [PLAN-A Memo Desktop] Web 원본은 붙여넣기 지표를 서버로 보낸다.
 * Desktop 은 로컬 앱이므로 아무 곳에도 보내지 않는다(같은 함수 모양만 유지).
 */
export interface InlineImageBatchMetrics {
    context?: string;
    requested_count?: number;
    uploaded_count?: number;
    failed_count?: number;
    blocked_by_limit_count?: number;
    existing_image_count?: number;
    max_image_count?: number;
    raw_bytes_total?: number;
    stored_bytes_total?: number;
    total_duration_ms?: number;
    max_image_duration_ms?: number;
    failure_reasons?: string[];
    failure_status_codes?: number[];
}

export async function reportInlineImageBatchMetrics(
    _metrics: InlineImageBatchMetrics,
): Promise<void> {
    // no-op: 로컬 앱은 운영 지표를 외부로 보내지 않는다.
}
