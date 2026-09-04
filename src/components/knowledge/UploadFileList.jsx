import { X, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { entryStatusText } from '@/lib/chunkPresets'
import { cn } from '@/lib/utils'

/**
 * UploadFileList —— 上传对话框的已选文件列表（含逐文件状态/进度）
 *
 * @param {Object} props
 * @param {Array} props.files       条目：{ file, status, stage?, error?, ... }
 * @param {{done:number,total:number}|null} props.batchProgress
 * @param {(idx:number)=>void} props.onRemove
 */
export function UploadFileList({ files, batchProgress, onRemove }) {
  if (files.length === 0) return null
  return (
    <ul className="flex max-h-40 flex-col gap-1 overflow-auto rounded-md border p-1.5 scrollbar-thin">
      {files.map((f, i) => (
        <li
          key={`${f.file.name}-${i}`}
          className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/40"
        >
          {f.status === 'ok' && (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          )}
          {f.status === 'fail' && (
            <XCircle
              className="h-3.5 w-3.5 shrink-0 text-destructive"
              title={f.error || ''}
            />
          )}
          {(f.status === 'pending' || f.status === 'ready') && (
            <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-input" />
          )}
          {(f.status === 'preparing' || f.status === 'committing') && (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          )}
          <span className="min-w-0 max-w-[45%] truncate">{f.file.name}</span>
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[10px]',
              f.status === 'fail'
                ? 'text-destructive'
                : 'text-muted-foreground',
            )}
            title={f.status === 'fail' ? f.error || '' : entryStatusText(f)}
          >
            {f.status === 'fail' ? f.error || '失败' : entryStatusText(f)}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10"
            onClick={() => onRemove(i)}
            aria-label={`移除 ${f.file.name}`}
            disabled={!!batchProgress}
          >
            <X className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  )
}

export default UploadFileList
