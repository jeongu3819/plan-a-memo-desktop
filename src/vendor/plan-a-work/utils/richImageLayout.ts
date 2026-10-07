/** Inline siblings wrap; paragraphs and br remain author-owned boundaries.
 * Only dimensions and permanent URLs belong in stored markup, never layout wrappers.
 */
export const richImageFlowSx = {
  display: 'inline-block',
  verticalAlign: 'top',
  maxWidth: '100%',
  height: 'auto',
  '&:not(:last-child)': {
    marginInlineEnd: '8px',
    maxWidth: 'calc(100% - 8px) !important',
  },
} as const;
