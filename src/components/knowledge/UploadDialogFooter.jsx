import { Upload, Loader2, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'

/**
 * UploadDialogFooter —— 上传对话框底部操作区：取消 / 预览切片 / 提交上传。
 * 纯受控组件：按钮禁用状态与进度文案来自 useUploadForm 的派生值。
 *
 * @param {Object} props
 * @param {boolean} [props.uploading] 外部上传状态（禁用取消/提交）
 * @param {{done:number,total:number}|null} [props.batchProgress] 批量进度（显示 n/m 并禁用其它按钮）
 * @param {string} [props.formError] 表单校验错误（非空禁用预览/提交）
 * @param {number} props.filesCount 已选文件数（0 禁用预览）
 * @param {number} props.uploadableCount 可上传条目数（0 禁用提交）
 * @param {()=>void} props.onCancel 关闭弹窗
 * @param {(e:*)=>void} props.onPreview 预览切片（服务端解析后弹窗展示）
 */
export function UploadDialogFooter({
  uploading = false,
  batchProgress = null,
  formError = '',
  filesCount,
  uploadableCount,
  onCancel,
  onPreview,
}) {
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="ghost"
        onClick={onCancel}
        disabled={uploading || !!batchProgress}
      >
        取消
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={onPreview}
        disabled={filesCount === 0 || !!formError || !!batchProgress}
        title="服务端解析并切片预览（支持 PDF / DOCX），确认效果后再入库"
      >
        <Eye className="mr-1.5 h-4 w-4" />
        预览切片
      </Button>
      <Button
        type="submit"
        disabled={
          uploadableCount === 0 ||
          uploading ||
          !!formError ||
          !!batchProgress
        }
      >
        {batchProgress ? (
          <>
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            {batchProgress.done}/{batchProgress.total}
          </>
        ) : (
          <>
            <Upload className="mr-1.5 h-4 w-4" />
            {uploadableCount > 1
              ? `上传 ${uploadableCount} 个文件`
              : '上传'}
          </>
        )}
      </Button>
    </DialogFooter>
  )
}

export default UploadDialogFooter
