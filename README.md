# receipt-relay

외근 영수증 증빙 사이트에서 휴대폰 → PC로 영수증 사진을 넘겨주는 작은 중계 서버입니다.

- QR 한 번마다 추측할 수 없는 일회용 세션을 씁니다.
- 사진은 PC가 받아 가는 즉시 삭제되고, 늦어도 첫 업로드 1시간 뒤 세션 전체가 자동 삭제됩니다.
- 사진 내용은 읽거나 기록하지 않습니다.
- Cloudflare Workers 무료 플랜(Durable Objects)으로 동작합니다.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/)
