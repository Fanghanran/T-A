# Elasticsearch 8.14.3 单节点 + IK 中文分词
# IK 插件版本必须与 ES 版本严格一致，构建时锁定同版本号。
FROM docker.elastic.co/elasticsearch/elasticsearch:8.14.3

RUN elasticsearch-plugin install --batch \
  https://get.infini.cloud/elasticsearch/analysis-ik/8.14.3
