# Vyron Code — Çalışma Alanı Kullanım Rehberi

Vyron Code, solda gezinti, ortada görev alanı olan koyu temalı bir masaüstü çalışma alanıdır.

## Sol panel

- **Projeler / Managers**: üstteki iki sekme sol panelin içeriğini değiştirir.
- **Yeni Görev, Yetenekler, Bağlayıcılar, Web sitesi yönetimi**: ana sayfalar.
- **Proje Listesi**: projeler ve altındaki görevler. Proje satırındaki **+** o projede yeni görev başlatır,
  klasör simgesi yeni proje ekler, **Daha Fazla** uzun listeleri açar. Ctrl+K (veya arama simgesi) listeyi filtreler.
- Alt kısımda hesap menüsü ve **Ayarlar**. Yan panel daraltılabilir; dar pencerede kendiliğinden simge şeridine iner.

## Yeni görev

- **Yerel** (çalışma modu) ve **Proje seç veya oluştur** seçicileri görev alanının üstündedir.
- **+** menüsü: *Resim veya dosya ekle*, *SubAgent* (managers), *Plan*, *Terminal*.
  Dosyalar çip olarak görünür ve göndermeden önce kaldırılabilir; bu sürümde yalnızca görev metni yerel AI'ya iletilir
  (ekler için uyarı görev alanında yazar). Terminal seçeneği yalnızca komut önerisi ister, hiçbir komut çalıştırmaz.
- **Yetenekler** ve **Bağlayıcılar** seçicileri arama alanı içerir; seçimler görev alanında çip olarak görünür.
- Hızlı başlangıç çipleri görev alanını bir şablonla doldurur; göndermez.
- Seçilen yetenek, manager, bağlayıcı, plan ve çalışma modu, görev metninin başına kısa bir bağlam notu olarak eklenir.

## Menüler ve klavye

Menüler tıklamayla açılır; dışarı tıklama veya Esc ile kapanır. Ok tuşları, Home/End gezinir, → alt menüyü açar, ← kapatır.
Ctrl+Enter gönderir, Enter yeni satır ekler.

## Bağlayıcılar

**Bağlan** bağlantıyı "yetkilendirme bekliyor" durumuna alır; hizmet hesabında yetkilendirmeyi tamamlayınca **Bağlantıyı onayla**
ile bağlı olarak işaretlenir. Bu sürüm yalnızca yerel bağlantı kaydını tutar; gerçek OAuth oturumu açmaz.

## Saklanan bilgiler

Projeler, görev başlıkları, seçimler, managers, bağlayıcı durumları ve web siteleri bu bilgisayarda saklanır.
**Görev metinleri, yanıtlar, taslaklar ve ekler saklanmaz.** Ayarlar > *Çalışma alanını sıfırla* her şeyi başlangıç haline döndürür.
