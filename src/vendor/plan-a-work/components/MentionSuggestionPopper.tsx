import React from 'react';
import { Avatar, Box, Popper, Typography } from '@mui/material';
import { planAiColors } from '../theme/tokens';
import { resolveAvatarColor } from '../utils/avatarColor';
import type { MentionCandidate } from '../utils/mentionMarkup';

/**
 * 본문 안 @멘션 후보 dropdown.
 *
 * 캐럿 위치(anchorRect)에 붙는 virtual anchor 를 쓴다. Portal 로 document.body 에 그리므로
 * Drawer/Dialog 의 overflow 에 잘리지 않는다(댓글 MentionTextField 와 같은 이유·같은 z-index).
 */
interface Props {
  open: boolean;
  anchorRect: DOMRect | null;
  suggestions: MentionCandidate[];
  highlight: number;
  /** 후보 자체가 없음(= 이 Task 에 담당자가 없음) — 문구가 달라진다. */
  hasCandidates: boolean;
  onHighlight: (index: number) => void;
  onSelect: (candidate: MentionCandidate) => void;
}

const MentionSuggestionPopper: React.FC<Props> = ({
  open, anchorRect, suggestions, highlight, hasCandidates, onHighlight, onSelect,
}) => {
  if (!open || !anchorRect) return null;

  const virtualAnchor = {
    getBoundingClientRect: () => anchorRect,
    // Popper v2 는 clientWidth/Height 를 참조하는 경로가 있다.
    clientWidth: anchorRect.width,
    clientHeight: anchorRect.height,
  } as unknown as HTMLElement;

  return (
    <Popper
      open
      anchorEl={virtualAnchor}
      placement="bottom-start"
      style={{ zIndex: 2100 }}
      modifiers={[
        { name: 'offset', options: { offset: [0, 6] } },
        { name: 'flip', enabled: true, options: { boundary: 'viewport', padding: 8 } },
        { name: 'preventOverflow', enabled: true, options: { boundary: 'viewport', padding: 8 } },
      ]}
    >
      <Box
        // mousedown 이 편집기 blur/선택 해제를 일으키지 않아야 클릭 선택이 확정된다.
        onMouseDown={(e) => e.preventDefault()}
        sx={{
          minWidth: 220,
          maxWidth: 340,
          bgcolor: '#fff',
          border: `1px solid ${planAiColors.border.soft}`,
          borderRadius: 1.5,
          boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
          maxHeight: 'min(260px, 40vh)',
          overflowY: 'auto',
          py: 0.5,
        }}
      >
        {suggestions.length === 0 ? (
          <Typography sx={{ fontSize: '0.75rem', color: planAiColors.text.muted, px: 1.3, py: 0.8 }}>
            {hasCandidates ? '일치하는 담당자가 없습니다.' : '멘션할 담당자가 없습니다.'}
          </Typography>
        ) : (
          suggestions.map((candidate, index) => (
            <Box
              key={candidate.userId}
              onMouseDown={(e) => { e.preventDefault(); onSelect(candidate); }}
              onMouseEnter={() => onHighlight(index)}
              sx={{
                display: 'flex', alignItems: 'center', gap: 1, px: 1.2, py: 0.7, cursor: 'pointer',
                bgcolor: index === highlight ? '#EEF2FF' : 'transparent',
              }}
            >
              <Avatar
                sx={{
                  width: 24, height: 24, fontSize: '0.7rem',
                  bgcolor: resolveAvatarColor(candidate.avatarColor, {
                    loginid: candidate.loginid || undefined,
                    userId: candidate.userId,
                  }),
                }}
              >
                {(candidate.name || '?').charAt(0).toUpperCase()}
              </Avatar>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: '0.8rem', fontWeight: 600, color: planAiColors.text.primary, lineHeight: 1.3 }}>
                  {candidate.name}
                  {candidate.loginid && (
                    <Typography component="span" sx={{ fontSize: '0.7rem', color: planAiColors.text.muted, ml: 0.5, fontWeight: 400 }}>
                      {candidate.loginid}
                    </Typography>
                  )}
                </Typography>
                {(candidate.deptname || candidate.mail) && (
                  <Typography sx={{ fontSize: '0.66rem', color: planAiColors.text.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {[candidate.deptname, candidate.mail].filter(Boolean).join(' · ')}
                  </Typography>
                )}
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Popper>
  );
};

export default MentionSuggestionPopper;
