import type { ButtonHTMLAttributes } from 'react'

/** Stand-in for the shadcn Switch: a button with role switch that reports its next state. */
export const Switch = ({ checked, onCheckedChange, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & { checked?: boolean; onCheckedChange?: (checked: boolean) => void }) => (
  <button type="button" role="switch" aria-checked={checked} onClick={() => onCheckedChange?.(!checked)} {...props} />
)
