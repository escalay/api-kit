/** Stand-in for a shadcn app's `cn`: joins the classes that are set. */
export const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')
