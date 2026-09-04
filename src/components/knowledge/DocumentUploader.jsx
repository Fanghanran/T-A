import { Upload, AlertCircle, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useUploadForm } from '@/hooks/useUploadForm'
import { ChunkStrategyForm } from './ChunkStrategyForm'
import { UploadFileList } from './UploadFileList'
import { UploadMetaFields } from './UploadMetaFields'
import { UploadDialogFooter } from './UploadDialogFooter'
import { ChunkPreviewDialog } from './ChunkPreviewDialog'

/**
 * DocumentUploader —— 上传文档对话框（壳组件：弹窗骨架 + 表单组合）
 *
 * 两段式上传（①）：prepare（服务端抽文本+切片+评分）→ commit（确认后 embedding+入库，
 * 异步 job 轮询进度）；commit 阶段 2 个 worker 并发处理多文件。
 * 状态与编排见 hooks/useUploadForm；策略表单见 ChunkStrategyForm；文件列表见
 * UploadFileList；元数据区见 UploadMetaFields；底部操作区见 UploadDialogFooter。
 *
 * @param {Object} props
 * @param {()=>void} [props.onUploaded] 全部（或部分）上传完成回调（父级刷新列表）
 * @param {boolean} props.uploading 兼容保留（内部自管状态，此参数仅用于禁用触发按钮）
 */
export function DocumentUploader({ onUploaded, uploading }) {
  const form = useUploadForm({ onUploaded, uploading })
  const {
    open, setOpen, reset,
    files, handleFiles, removeFileAt, uploadableCount, batchProgress,
    presetKey, chunkStrategy, delimiter, setDelimiter, maxChars, setMaxChars,
    overlapChars, setOverlapChars,
    selectPreset, applyTemplate, maxCharsError, overlapError, formError,
    category, setCategory, tags, setTags, tagInput, setTagInput, addTag,
    withQuestions, setWithQuestions,
    templates, templatesError,
    handleSubmit, handlePreview,
    previewOpen, setPreviewOpen, previewData,
  } = form

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button
          size="sm"
          className="shrink-0"
          disabled={!!batchProgress || uploading}
        >
          <Upload className="mr-1.5 h-4 w-4" />
          上传
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogTitle>上传知识文档</DialogTitle>
        <DialogDescription>
          两段式上传：先在服务端解析切片（可预览
          PDF/DOCX），确认后并发入库；重复内容自动拦截。
        </DialogDescription>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4 pt-2">
          {/* 文件选择（多选） */}
          <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-input px-4 py-5 text-center text-sm text-muted-foreground transition-colors hover:bg-accent/50">
            <Upload className="h-5 w-5" />
            <span>点击选择文件（可多选）</span>
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={handleFiles}
              accept=".md,.markdown,.txt,.html,.htm,.csv,.tsv,.log,.json,.yaml,.yml,.pdf,.docx"
            />
          </label>

          {/* 已选文件列表（含逐文件进度 ④） */}
          <UploadFileList
            files={files}
            batchProgress={batchProgress}
            onRemove={removeFileAt}
          />

          {/* 处理模板：一键填充切片参数 */}
          {templates.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                <Layers className="h-3.5 w-3.5" />
                套用处理模板（常用切片参数组合）
              </span>
              <div className="flex flex-wrap gap-1.5">
                {templates.map((t) => (
                  <button
                    key={t.id ?? t.name}
                    type="button"
                    className="rounded-full border border-input px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
                    onClick={() => applyTemplate(t)}
                    disabled={!!batchProgress}
                    title={`${t.strategy === 'delimiter' ? `分隔符「${t.delimiter ?? ''}」· 目标 ${t.maxChars} 字` : '语义感知切片'}${t.name ? ` · 模板「${t.name}」` : ''}`}
                  >
                    {t.name || '未命名模板'}
                  </button>
                ))}
              </div>
            </div>
          )}
          {templatesError && (
            <span className="text-[11px] text-muted-foreground">
              模板不可用：{templatesError}
            </span>
          )}

          {/* 切片策略（预设 chips + 自定义参数） */}
          <ChunkStrategyForm
            presetKey={presetKey}
            chunkStrategy={chunkStrategy}
            delimiter={delimiter}
            maxChars={maxChars}
            overlapChars={overlapChars}
            maxCharsError={maxCharsError}
            overlapError={overlapError}
            disabled={!!batchProgress}
            onSelectPreset={selectPreset}
            onDelimiterChange={setDelimiter}
            onMaxCharsChange={setMaxChars}
            onOverlapCharsChange={setOverlapChars}
          />

          {/* 分类 / 标签 / 检索增强问题开关（元数据区） */}
          <UploadMetaFields
            category={category}
            onCategoryChange={setCategory}
            tags={tags}
            onTagsChange={setTags}
            tagInput={tagInput}
            onTagInputChange={setTagInput}
            onAddTag={addTag}
            withQuestions={withQuestions}
            onWithQuestionsChange={setWithQuestions}
            disabled={!!batchProgress}
          />

          {formError && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          {/* 底部操作：取消 / 预览切片 / 提交上传 */}
          <UploadDialogFooter
            uploading={uploading}
            batchProgress={batchProgress}
            formError={formError}
            filesCount={files.length}
            uploadableCount={uploadableCount}
            onCancel={() => setOpen(false)}
            onPreview={handlePreview}
          />
        </form>
      </DialogContent>

      <ChunkPreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        chunks={previewData?.error ? [] : previewData?.chunks}
        total={previewData?.total}
        strategy={chunkStrategy}
        error={previewData?.loading ? null : previewData?.error}
      />
    </Dialog>
  )
}

export default DocumentUploader
