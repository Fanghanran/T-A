import { Input } from '@/components/ui/input'
import {
  MAX_CHARS_MIN,
  MAX_CHARS_MAX,
  OVERLAP_MIN,
  OVERLAP_MAX,
  CHUNK_PRESETS,
} from '@/lib/chunkPresets'
import { cn } from '@/lib/utils'

/**
 * ChunkStrategyForm —— 上传对话框的切片策略区（预设 chips + 自定义参数表单）
 *
 * 纯受控组件：所有值与回调来自 useUploadForm。
 *
 * @param {Object} props
 * @param {string} props.presetKey
 * @param {'semantic'|'delimiter'} props.chunkStrategy
 * @param {string} props.delimiter
 * @param {number} props.maxChars
 * @param {number} props.overlapChars
 * @param {string} props.maxCharsError
 * @param {string} props.overlapError
 * @param {boolean} [props.disabled] 批量上传进行中禁用全部输入
 * @param {(p:object)=>void} props.onSelectPreset
 * @param {(v:string)=>void} props.onDelimiterChange
 * @param {(v:number)=>void} props.onMaxCharsChange
 * @param {(v:number)=>void} props.onOverlapCharsChange
 */
export function ChunkStrategyForm({
  presetKey,
  chunkStrategy,
  delimiter,
  maxChars,
  overlapChars,
  maxCharsError,
  overlapError,
  disabled = false,
  onSelectPreset,
  onDelimiterChange,
  onMaxCharsChange,
  onOverlapCharsChange,
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">
        切片策略
      </span>
      <div className="flex flex-wrap gap-1.5">
        {CHUNK_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => onSelectPreset(p)}
            disabled={disabled}
            title={p.hint}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
              presetKey === p.key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input text-muted-foreground hover:border-primary/50 hover:bg-primary/5 hover:text-primary',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {/* 选中预设的说明（自定义模式显示手填表单） */}
      {presetKey !== 'custom' && (
        <span className="text-[11px] text-muted-foreground">
          {CHUNK_PRESETS.find((p) => p.key === presetKey)?.hint}
        </span>
      )}

      {chunkStrategy === 'delimiter' && (
        <>
          {/* 自定义才可编辑分隔符；预设的分隔符已定，只暴露目标字数微调 */}
          {presetKey === 'custom' ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                分隔符 <span className="text-destructive">*</span>
              </span>
              <Input
                value={delimiter}
                onChange={(e) => onDelimiterChange(e.target.value)}
                placeholder="例如：--- 或 ##；也可粘贴换行（按行切分）"
                maxLength={50}
                disabled={disabled}
              />
              <span className="text-[11px] text-muted-foreground">
                文档将按此字符串切分为多个切片；不做语义细切。
              </span>
            </label>
          ) : (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>分隔符：</span>
              <code className="rounded bg-muted px-1.5 py-0.5">
                {presetKey === 'para'
                  ? '空行（双换行）'
                  : presetKey === 'line'
                    ? '换行符'
                    : delimiter || '—'}
              </code>
              <span>· 想改用其他符号请切「自定义」</span>
            </div>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              目标字数（{MAX_CHARS_MIN}~{MAX_CHARS_MAX}）
            </span>
            <Input
              type="number"
              value={maxChars}
              onChange={(e) => onMaxCharsChange(Number(e.target.value))}
              min={MAX_CHARS_MIN}
              max={MAX_CHARS_MAX}
              aria-invalid={!!maxCharsError}
              disabled={disabled}
            />
            {maxCharsError ? (
              <span className="text-[11px] text-destructive">
                {maxCharsError}
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                单个切片目标字数，超长段会再按段落切分。
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              相邻块重叠（{OVERLAP_MIN}~{OVERLAP_MAX} 字符）
            </span>
            <Input
              type="number"
              value={overlapChars}
              onChange={(e) => onOverlapCharsChange(Number(e.target.value))}
              min={OVERLAP_MIN}
              max={OVERLAP_MAX}
              aria-invalid={!!overlapError}
              disabled={disabled}
            />
            {overlapError ? (
              <span className="text-[11px] text-destructive">
                {overlapError}
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                后一块以前一块末尾 N
                字符开头（滑动窗口），缓解分隔符切断句子的上下文丢失；0 =
                不重叠（默认）。
              </span>
            )}
          </label>
        </>
      )}
    </div>
  )
}

export default ChunkStrategyForm
