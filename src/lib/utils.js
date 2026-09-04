import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * cn —— shadcn/ui 标准的 className 合并工具
 * 合并 clsx 条件类名，再用 tailwind-merge 去重冲突的 Tailwind 类。
 * @param  {...any} inputs
 * @returns {string}
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
