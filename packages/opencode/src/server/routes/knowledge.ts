import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Knowledge, Storage } from "../../knowledge"
import { getDefaultDimensions, detectDimensions } from "../../knowledge/embedding"
import { KnowledgeIndexSchema, SearchResultSchema, EmbeddingModelInfoSchema } from "../../knowledge/types"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"
import { setKnowledgeConfig, getKnowledgeConfig } from "../../tool/knowledge"
import path from "path"

const log = Log.create({ service: "knowledge" })

// 请求/响应 schemas
const CreateKnowledgeBaseSchema = z.object({
  path: z.string().meta({ description: "知识库文件夹路径" }),
  name: z.string().meta({ description: "知识库名称" }),
  embeddingProvider: z.enum(["openai", "local", "custom"]).meta({ description: "嵌入模型提供商" }),
  embeddingModel: z.string().meta({ description: "嵌入模型 ID" }),
  embeddingDimensions: z.number().optional().meta({ description: "嵌入向量维度（可选，默认使用模型默认值）" }),
  apiKey: z.string().optional().meta({ description: "API 密钥（OpenAI/Custom 需要）" }),
  baseURL: z.string().optional().meta({ description: "自定义 API 地址" }),
  chunkSize: z.number().optional().default(512).meta({ description: "分块大小" }),
  chunkOverlap: z.number().optional().default(50).meta({ description: "分块重叠" }),
})

const SyncKnowledgeBaseSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
})

const SearchSchema = z.object({
  query: z.string().meta({ description: "搜索查询" }),
  topK: z.number().optional().default(5).meta({ description: "返回结果数量" }),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
})

const UpdateConfigSchema = z.object({
  embeddingProvider: z.enum(["openai", "local", "custom"]).optional(),
  embeddingModel: z.string().optional(),
  embeddingDimensions: z.number().optional(),
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
})

const ImportSchema = z.object({
  paths: z.array(z.string()).min(1),
})

export const KnowledgeRoutes = lazy(() =>
  new Hono()
    // 列出可用的嵌入模型
    .get(
      "/models",
      describeRoute({
        summary: "List embedding models",
        description: "获取所有可用的嵌入模型列表",
        operationId: "knowledge.models.list",
        responses: {
          200: {
            description: "嵌入模型列表",
            content: {
              "application/json": {
                schema: resolver(z.array(EmbeddingModelInfoSchema)),
              },
            },
          },
        },
      }),
      async (c) => {
        const models = Knowledge.listModels()
        return c.json(models)
      },
    )
    // 创建知识库
    .post(
      "/",
      describeRoute({
        summary: "Create knowledge base",
        description: "创建新的知识库",
        operationId: "knowledge.create",
        responses: {
          200: {
            description: "知识库创建成功",
            content: {
              "application/json": {
                schema: resolver(KnowledgeIndexSchema),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", CreateKnowledgeBaseSchema),
      async (c) => {
        const opts = c.req.valid("json")
        log.info("creating knowledge base", { path: opts.path, name: opts.name, model: opts.embeddingModel })

        // 自动检测维度：优先使用用户指定的维度，否则尝试从已知模型获取，最后自动检测
        let dimensions: number | undefined = opts.embeddingDimensions

        if (!dimensions) {
          // 尝试从已知模型列表中获取
          const defaultDims = getDefaultDimensions(opts.embeddingModel)
          if (defaultDims !== null) {
            dimensions = defaultDims
          }
        }

        if (!dimensions) {
          // 未知模型，自动检测维度
          log.info("auto-detecting dimensions", { provider: opts.embeddingProvider, model: opts.embeddingModel })
          dimensions = await detectDimensions({
            provider: opts.embeddingProvider,
            model: opts.embeddingModel,
            apiKey: opts.apiKey,
            baseURL: opts.baseURL,
          })
          log.info("detected dimensions", { model: opts.embeddingModel, dimensions })
        }

        const index = await Knowledge.create({
          path: opts.path,
          name: opts.name,
          embeddingProvider: opts.embeddingProvider,
          embeddingModel: opts.embeddingModel,
          embeddingDimensions: dimensions,
          apiKey: opts.apiKey,
          baseURL: opts.baseURL,
          chunkSize: opts.chunkSize,
          chunkOverlap: opts.chunkOverlap,
        })

        return c.json(index)
      },
    )
    // 设置全局知识库配置（供前端调用）
    // NOTE: 必须在 /:path{.+} 之前注册，否则会被 catch-all 路由拦截
    .post(
      "/config",
      describeRoute({
        summary: "Set knowledge config",
        description: "设置全局知识库配置，供 knowledge_search 工具使用",
        operationId: "knowledge.config.set",
        responses: {
          200: {
            description: "配置成功",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          apiKey: z.string().optional(),
          baseURL: z.string().optional(),
        }),
      ),
      async (c) => {
        const opts = c.req.valid("json")
        setKnowledgeConfig({
          path: opts.path,
          apiKey: opts.apiKey,
          baseURL: opts.baseURL,
        })
        log.info("set knowledge config", { path: opts.path })
        return c.json({ ok: true })
      },
    )
    // 获取全局知识库配置
    // NOTE: 必须在 /:path{.+} 之前注册，否则会被 catch-all 路由拦截
    .get(
      "/config",
      describeRoute({
        summary: "Get knowledge config",
        description: "获取全局知识库配置",
        operationId: "knowledge.config.get",
        responses: {
          200: {
            description: "当前配置",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    path: z.string().optional(),
                    apiKey: z.string().optional(),
                    baseURL: z.string().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = getKnowledgeConfig()
        return c.json(config ?? {})
      },
    )
    // 获取知识库统计信息
    // NOTE: 必须在 GET /:path{.+} 之前注册！否则 /:path{.+} 会贪婪匹配整个路径
    // 包括 /stats 后缀，导致 stats 请求被错误地路由到 GET /:path{.+} 处理器，
    // 返回 404，前端 refreshAllStats() 静默忽略，doc count 永远显示 0。
    .get(
      "/:path{.+}/stats",
      describeRoute({
        summary: "Get knowledge base stats",
        description: "获取知识库统计信息",
        operationId: "knowledge.stats",
        responses: {
          200: {
            description: "统计信息",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    totalDocuments: z.number(),
                    totalChunks: z.number(),
                    pdfFileCount: z.number(),
                    lastSyncedAt: z.number().optional(),
                    embeddingModel: z.string(),
                    embeddingProvider: z.string(),
                    chunkSize: z.number(),
                    chunkOverlap: z.number(),
                  }),
                ),
              },
            },
          },
          404: {
            description: "知识库不存在",
          },
        },
      }),
      async (c) => {
        const dir = decodeURIComponent(c.req.param("path"))
        const index = await Knowledge.load(dir)

        if (!index) {
          const docs = await Storage.listDocumentFiles(dir)
          return c.json({
            totalDocuments: 0,
            totalChunks: 0,
            pdfFileCount: docs.length,
            lastSyncedAt: 0,
            embeddingModel: "",
            embeddingProvider: "",
            chunkSize: 0,
            chunkOverlap: 0,
          })
        }

        const stats = await Knowledge.getStats(index)
        return c.json(stats)
      },
    )
    // 获取知识库信息
    .get(
      "/:path{.+}",
      describeRoute({
        summary: "Get knowledge base",
        description: "获取知识库详细信息",
        operationId: "knowledge.get",
        responses: {
          200: {
            description: "知识库信息",
            content: {
              "application/json": {
                schema: resolver(KnowledgeIndexSchema),
              },
            },
          },
          404: {
            description: "知识库不存在",
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const dir = decodeURIComponent(c.req.param("path"))
        const index = await Knowledge.load(dir)

        if (!index) {
          return c.json({ error: "Knowledge base not found" }, 404)
        }

        return c.json(index)
      },
    )
    // 更新知识库配置
    .patch(
      "/:path{.+}/config",
      describeRoute({
        summary: "Update knowledge base config",
        description: "更新知识库嵌入模型配置，模型变更时会清空索引并等待重新同步",
        operationId: "knowledge.config.update",
        responses: {
          200: {
            description: "更新后的知识库",
            content: {
              "application/json": {
                schema: resolver(KnowledgeIndexSchema),
              },
            },
          },
          404: {
            description: "知识库不存在",
          },
          ...errors(400),
        },
      }),
      validator("json", UpdateConfigSchema),
      async (c) => {
        const dir = decodeURIComponent(c.req.param("path"))
        const opts = c.req.valid("json")

        const index = await Knowledge.load(dir)
        if (!index) {
          return c.json({ error: "Knowledge base not found" }, 404)
        }

        const provider = opts.embeddingProvider ?? index.config.embeddingProvider
        const model = opts.embeddingModel ?? index.config.embeddingModel
        const apiKey = opts.apiKey ?? index.config.apiKey
        const baseURL = opts.baseURL ?? index.config.baseURL

        let dimensions = opts.embeddingDimensions
        if (!dimensions) {
          const known = getDefaultDimensions(model)
          if (known !== null) {
            dimensions = known
          }
        }
        if (!dimensions) {
          dimensions = await detectDimensions({
            provider,
            model,
            apiKey,
            baseURL,
          })
        }

        const updated = await Knowledge.updateConfig(dir, index, {
          embeddingProvider: provider,
          embeddingModel: model,
          embeddingDimensions: dimensions,
          apiKey,
          baseURL,
        })

        return c.json(updated)
      },
    )
    // 导入文档文件到知识库目录
    .post(
      "/:path{.+}/import",
      describeRoute({
        summary: "Import files into knowledge base",
        description: "复制文件到知识库目录（不自动同步）",
        operationId: "knowledge.import",
        responses: {
          200: {
            description: "导入结果",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    added: z.number(),
                    skipped: z.number(),
                    errors: z.array(z.string()),
                  }),
                ),
              },
            },
          },
          404: {
            description: "知识库不存在",
          },
        },
      }),
      validator("json", ImportSchema),
      async (c) => {
        const dir = decodeURIComponent(c.req.param("path"))
        const opts = c.req.valid("json")

        const index = await Knowledge.load(dir)
        if (!index) {
          return c.json({ error: "Knowledge base not found" }, 404)
        }

        const allow = new Set([".pdf", ".md", ".markdown", ".txt", ".tex", ".rst", ".json", ".yml", ".yaml", ".csv"])
        let added = 0
        let skipped = 0
        const errors: string[] = []

        for (const src of opts.paths) {
          const ext = path.extname(src).toLowerCase()
          if (!allow.has(ext)) {
            skipped++
            errors.push(`Unsupported file type: ${src}`)
            continue
          }

          const from = Bun.file(src)
          if (!(await from.exists())) {
            skipped++
            errors.push(`File not found: ${src}`)
            continue
          }

          let to = path.join(dir, path.basename(src))
          if (to === src) {
            skipped++
            continue
          }

          let i = 1
          while (await Bun.file(to).exists()) {
            to = path.join(dir, `${path.basename(src, ext)}-${i}${ext}`)
            i++
          }

          try {
            const data = await from.arrayBuffer()
            await Bun.write(to, new Uint8Array(data))
            added++
          } catch (err: any) {
            skipped++
            errors.push(`Failed to import ${src}: ${err?.message || err}`)
          }
        }

        return c.json({ added, skipped, errors })
      },
    )
    // 删除知识库
    .delete(
      "/:path{.+}",
      describeRoute({
        summary: "Delete knowledge base",
        description: "删除知识库（仅删除索引，不删除原文件）",
        operationId: "knowledge.delete",
        responses: {
          200: {
            description: "删除成功",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
          404: {
            description: "知识库不存在",
          },
        },
      }),
      async (c) => {
        const dir = decodeURIComponent(c.req.param("path"))
        log.info("deleting knowledge base", { path: dir })

        await Knowledge.remove(dir)
        return c.json({ ok: true })
      },
    )
    // 同步知识库
    .post(
      "/:path{.+}/sync",
      describeRoute({
        summary: "Sync knowledge base",
        description: "同步知识库文件夹，处理新增的可支持文档，以 SSE 流式返回进度",
        operationId: "knowledge.sync",
        responses: {
          200: {
            description: "SSE 进度流，最终事件为 complete 或 error",
            content: {
              "text/event-stream": {
                schema: resolver(z.object({ event: z.string(), data: z.string() })),
              },
            },
          },
          404: {
            description: "知识库不存在",
          },
          ...errors(400),
        },
      }),
      validator("json", SyncKnowledgeBaseSchema.optional()),
      async (c) => {
        const dir = decodeURIComponent(c.req.param("path"))
        const opts = c.req.valid("json") || {}

        log.info("syncing knowledge base", { path: dir })

        const index = await Knowledge.load(dir)
        if (!index) {
          return c.json({ error: "Knowledge base not found" }, 404)
        }

        return streamSSE(c, async (stream) => {
          const abortSignal = c.req.raw.signal
          try {
            // 优先使用请求中的 apiKey/baseURL，否则使用 index.config 中保存的
            const result = await Knowledge.sync(dir, index, {
              apiKey: opts.apiKey || index.config.apiKey,
              baseURL: opts.baseURL || index.config.baseURL,
              signal: abortSignal,
              onProgress: async (status) => {
                await stream.writeSSE({
                  event: "progress",
                  data: JSON.stringify(status),
                })
              },
            })
            if (!abortSignal.aborted) {
              await stream.writeSSE({
                event: "complete",
                data: JSON.stringify(result),
              })
            }
          } catch (err: any) {
            if (abortSignal.aborted) return
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ message: err?.message || String(err) }),
            })
          }
        })
      },
    )
    // 搜索知识库
    .post(
      "/:path{.+}/search",
      describeRoute({
        summary: "Search knowledge base",
        description: "在知识库中搜索相关内容",
        operationId: "knowledge.search",
        responses: {
          200: {
            description: "搜索结果",
            content: {
              "application/json": {
                schema: resolver(z.array(SearchResultSchema)),
              },
            },
          },
          404: {
            description: "知识库不存在",
          },
          ...errors(400),
        },
      }),
      validator("json", SearchSchema),
      async (c) => {
        const dir = decodeURIComponent(c.req.param("path"))
        const opts = c.req.valid("json")

        log.info("searching knowledge base", { path: dir, query: opts.query })

        const index = await Knowledge.load(dir)
        if (!index) {
          return c.json({ error: "Knowledge base not found" }, 404)
        }

        // 优先使用请求中的 apiKey/baseURL，否则使用 index.config 中保存的
        const results = await Knowledge.search(dir, index, opts.query, {
          apiKey: opts.apiKey || index.config.apiKey,
          baseURL: opts.baseURL || index.config.baseURL,
          topK: opts.topK,
        })

        return c.json(results)
      },
    )
    // 删除文档
    .delete(
      "/:path{.+}/document/:documentId",
      describeRoute({
        summary: "Delete document",
        description: "从知识库中删除指定文档",
        operationId: "knowledge.document.delete",
        responses: {
          200: {
            description: "删除成功",
            content: {
              "application/json": {
                schema: resolver(KnowledgeIndexSchema),
              },
            },
          },
          404: {
            description: "知识库或文档不存在",
          },
        },
      }),
      async (c) => {
        const dir = decodeURIComponent(c.req.param("path"))
        const documentId = c.req.param("documentId")

        log.info("deleting document from knowledge base", { path: dir, documentId })

        const index = await Knowledge.load(dir)
        if (!index) {
          return c.json({ error: "Knowledge base not found" }, 404)
        }

        const updatedIndex = await Knowledge.removeDocument(dir, index, documentId)
        return c.json(updatedIndex)
      },
    )
    // 获取文档文件内容 - 用于在网页中预览
    .get("/file", async (c) => {
      const url = new URL(c.req.url)
      const filePath = url.searchParams.get("path")

      if (!filePath) {
        return c.json({ error: "Missing path parameter" }, 400)
      }

      try {
        const file = Bun.file(filePath)
        const exists = await file.exists()

        if (!exists) {
          return c.json({ error: "File not found" }, 404)
        }

        const data = await file.arrayBuffer()
        const filename = filePath.split("/").pop() || "document.pdf"
        const ext = filename.split(".").pop()?.toLowerCase() || ""
        const type =
          ext === "pdf"
            ? "application/pdf"
            : ext === "md" || ext === "markdown"
              ? "text/markdown; charset=utf-8"
              : ext === "txt" || ext === "tex" || ext === "rst"
                ? "text/plain; charset=utf-8"
                : ext === "json"
                  ? "application/json; charset=utf-8"
                  : ext === "yaml" || ext === "yml"
                    ? "application/yaml; charset=utf-8"
                    : ext === "csv"
                      ? "text/csv; charset=utf-8"
                      : "application/octet-stream"

        return new Response(data, {
          headers: {
            "Content-Type": type,
            "Content-Disposition": `inline; filename="${filename}"`,
          },
        })
      } catch (err) {
        log.error("Failed to read document file", { path: filePath, error: err })
        return c.json({ error: "Failed to read file" }, 500)
      }
    }),
)
