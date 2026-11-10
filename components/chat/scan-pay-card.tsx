"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * 渲染一张「扫码/唤起支付」卡片。
 * 用于 AI/MCP 返回的、浏览器无法直接打开的支付 scheme（如微信 Native 扫码付
 * weixin://wxpay/bizpayurl?pr=xxx、支付宝 alipays://...）。
 * 同时给三条路：二维码（另一台设备扫/长按识别）、在钱包中打开（同机唤起，尽力而为）、复制支付码。
 */
export function ScanPayCard({ url }: { url: string }) {
  const [qr, setQr] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const isAlipay = /^alipays?:/i.test(url);
  const wallet = isAlipay ? "支付宝" : "微信";

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { width: 240, margin: 2 })
      .then((dataUrl) => { if (alive) setQr(dataUrl); })
      .catch(() => { if (alive) setQr(""); });
    return () => { alive = false; };
  }, [url]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard 不可用时静默忽略，用户仍可用二维码 */
    }
  };

  return (
    <div className="scan-pay-card">
      <div className="scan-pay-title">{wallet}支付</div>
      {qr ? (
        <img className="scan-pay-qr" src={qr} alt={`${wallet}支付二维码`} draggable={false} />
      ) : (
        <div className="scan-pay-qr scan-pay-qr-fallback">二维码生成失败</div>
      )}
      <div className="scan-pay-hint">用另一台设备打开{wallet}扫码，或长按二维码识别</div>
      <div className="scan-pay-actions">
        <a className="scan-pay-btn scan-pay-btn-primary" href={url}>打开{wallet}</a>
        <button type="button" className="scan-pay-btn" onClick={copy}>
          {copied ? "已复制" : "复制支付码"}
        </button>
      </div>
    </div>
  );
}
