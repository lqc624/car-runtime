# landlock-run 构建单源（M3部署设计增补 §2.1.2：J-01 单点编译，J-05/J-17 消费产物，禁止平台内重编译）
# 目标三元组：linux-x64-gnu；产物指纹随 J-01 SBOM 下发，消费方启动时校验 sha256
CC      ?= cc
CFLAGS  ?= -O2 -std=c11 -Wall -Wextra -Werror
TARGET   := landlock-run

.PHONY: all clean verify

all: $(TARGET)

$(TARGET): landlock-run.c
	$(CC) $(CFLAGS) -o $@ $<

# 消费方（J-05/J-17）产物指纹校验入口
verify: $(TARGET)
	sha256sum $(TARGET)

clean:
	rm -f $(TARGET)
