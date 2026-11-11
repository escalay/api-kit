import type { ButtonHTMLAttributes } from 'react'

/** Stand-in for the shadcn Button: a button that takes (and ignores) variant and size. */
export const Button = ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />
