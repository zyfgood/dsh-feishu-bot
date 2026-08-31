/**
 * 邮件通知：基于 nodemailer 的 SMTP 发送（参照皇帝的项目
 * invoice-email-notify/send_email.py 的配置约定：SMTP_SSL + 465）。
 *
 * 凭证来自插件 config 的 email 段（user/pass 支持 `env:VAR` 引用）。
 *
 * @module dsh-feishu-bot/mail
 */
import nodemailer from 'nodemailer';
/**
 * 发送一封邮件。
 * @param config - SMTP 配置（user/pass 已解析为真实值）。
 * @param to - 收件人（逗号分隔多个）。
 * @param subject - 主题。
 * @param content - 正文（text 或 html）。
 * @param html - content 是否按 HTML 发送。
 */
export async function sendEmail(config, to, subject, content, html) {
    const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port ?? 465,
        secure: config.secure ?? true,
        auth: { user: config.user, pass: config.pass },
        // 显式超时：避免不可达 SMTP 导致 60s 级别的挂起（nodemailer 默认过长）。
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
    });
    try {
        const info = await transporter.sendMail({
            from: config.user,
            to,
            subject,
            ...(html ? { html: content } : { text: content }),
        });
        return {
            messageId: info.messageId,
            accepted: (info.accepted ?? []).map(item => typeof item === 'string' ? item : item.address),
        };
    }
    finally {
        transporter.close();
    }
}
//# sourceMappingURL=mail.js.map