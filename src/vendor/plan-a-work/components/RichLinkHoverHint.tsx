import React, { useCallback, useEffect, useState } from 'react';
import { Box, Tooltip } from '@mui/material';
import { anchorFromEvent } from '../utils/richLinkDom';

/**
 * 편집기 안의 링크에 마우스를 올렸을 때 뜨는 사용법 안내 — Description·작업노트 공통.
 *
 * 왜 필요한가: contentEditable 안에서 링크를 그냥 누르면 커서가 놓일 뿐 열리지 않는다.
 * 편집 중에 글자를 고르거나 커서를 두려면 그래야 하지만, 그 규칙을 모르는 사람에게는
 * "눌러도 아무 일이 없는 링크"로 보인다. 여는 방법을 링크 위에서 바로 알려 준다.
 *
 * ⚠️ 안내일 뿐 기능이 아니다. 실제로 여는 것은 지금까지처럼 Ctrl/⌘+클릭이며,
 * 일반 클릭의 편집 동작도 그대로다.
 *
 * 구현 메모: 링크는 contentEditable 안의 **DOM 노드**라 React 요소로 감쌀 수 없다.
 * 그래서 MUI Tooltip 을 링크 위치에 겹쳐 둔 보이지 않는 상자에 붙인다. 상자는
 * `pointer-events: none` 이라 클릭·선택·드래그를 가로채지 않는다.
 */

export const RICH_LINK_OPEN_HINT = 'Ctrl + 클릭하여 링크 열기';

interface Props {
    /** 편집 표면(contentEditable) 의 ref. 이 안의 링크만 대상으로 한다. */
    rootRef: React.RefObject<HTMLElement | null>;
    /**
     * 안내를 잠시 멈춘다. Description 은 링크를 클릭하면 열기/편집/제거 팝오버가 뜨는데,
     * 그 위에 안내까지 겹치면 시끄럽다.
     */
    suppressed?: boolean;
}

const RichLinkHoverHint: React.FC<Props> = ({ rootRef, suppressed = false }) => {
    const [rect, setRect] = useState<DOMRect | null>(null);

    const clear = useCallback(() => setRect(null), []);

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return undefined;

        const handleOver = (event: MouseEvent) => {
            const anchor = anchorFromEvent(event.target, root);
            setRect(anchor ? anchor.getBoundingClientRect() : null);
        };
        // 링크 밖으로 나가면 즉시 감춘다. 편집기 밖으로 나가는 경우도 같은 이유로 잡는다.
        const handleOut = (event: MouseEvent) => {
            const next = event.relatedTarget;
            if (next instanceof Node && anchorFromEvent(next, root)) return;
            clear();
        };

        root.addEventListener('mouseover', handleOver);
        root.addEventListener('mouseout', handleOut);
        // 스크롤하면 링크가 움직이므로 좌표가 어긋난다 — 다시 올리면 그때 계산한다.
        window.addEventListener('scroll', clear, true);
        window.addEventListener('resize', clear);
        return () => {
            root.removeEventListener('mouseover', handleOver);
            root.removeEventListener('mouseout', handleOut);
            window.removeEventListener('scroll', clear, true);
            window.removeEventListener('resize', clear);
        };
        // rootRef.current 는 mount 후 채워지므로 의존성에 넣지 않는다(ref 는 안정적이다).
    }, [rootRef, clear]);

    if (!rect || suppressed) return null;
    return (
        <Tooltip open title={RICH_LINK_OPEN_HINT} placement="top" arrow>
            {/* 링크와 같은 자리에 겹쳐 두는 빈 상자 — 화면에 보이지 않고 입력도 가로채지 않는다. */}
            <Box
                aria-hidden
                sx={{
                    position: 'fixed',
                    top: rect.top,
                    left: rect.left,
                    width: rect.width,
                    height: rect.height,
                    pointerEvents: 'none',
                    zIndex: 1,
                }}
            />
        </Tooltip>
    );
};

export default RichLinkHoverHint;
