// installer/src/Ui.cs — custom-painted controls: button, checkbox, titlebar,
// step rail, progress bar. Each animates via Tick(dt) called from the form's
// single animation timer so there is exactly one invalidate loop when idle.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace EhSetup
{
    public enum BtnKind { Primary, Ghost, Danger }

    // ── Button ─────────────────────────────────────────────────────────────────
    public sealed class UiButton : Control
    {
        public BtnKind Kind = BtnKind.Primary;
        public int Radius = S.RadiusSm;
        public int MinWidth = 132;
        public int Height42 = 42;
        private Tween hover = new Tween(0F);
        private float press;
        private List<Ripple> ripples = new List<Ripple>();
        public bool Animated = true;

        public UiButton()
        {
            // SupportsTransparentBackColor makes OnPaintBackground paint the
            // parent's real background into our backbuffer BEFORE the rounded
            // fill — so the anti-aliased corner pixels blend with what's behind
            // the button instead of transparent black (which fringes the edges).
            SetStyle(ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Font = F.Button;
            Cursor = Cursors.Hand;
            Size = new Size(132, 42);
        }

        public void SetKind(BtnKind k) { Kind = k; Invalidate(); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle r = ClientRectangle;
            // Squish slightly on press (scale<1); hover stays full-size and is
            // expressed only via the glow. Inset only when actually shrinking so
            // the fill reaches the control edge and corners stay clean.
            float scale = 1F + hover.Value * 0.02F - press * 0.03F;
            Rectangle body = r;
            if (scale < 1F)
            {
                int dx = (int)Math.Round((1F - scale) * r.Width / 2F);
                int dy = (int)Math.Round((1F - scale) * r.Height / 2F);
                body = new Rectangle(r.X + dx, r.Y + dy, r.Width - 2 * dx, r.Height - 2 * dy);
            }

            // amber glow on hover (primary) — soft halo, like the app's accent
            if (Kind == BtnKind.Primary && hover.Value > 0.01F)
            {
                G.GlowRound(g, body, Radius, Color.FromArgb((int)(hover.Value * 130), C.Accent), 7);
            }

            // fill — paint the full body; G.DrawRound insets its own stroke by 1px
            // so a 1px centered border fits inside the control without spilling.
            if (Kind == BtnKind.Primary)
            {
                using (GraphicsPath p = G.Round(body, Radius))
                using (Brush b = G.AccentBrush(body)) g.FillPath(b, p);
                if (hover.Value > 0.01F)
                {
                    using (GraphicsPath p = G.Round(body, Radius))
                    using (LinearGradientBrush lb = new LinearGradientBrush(body, Color.FromArgb((int)(hover.Value * 40), 255, 255, 255), Color.FromArgb(0, 255, 255, 255), 90F))
                        g.FillPath(lb, p);
                }
            }
            else
            {
                Color fill = G.Mix(C.SurfaceHi, C.SurfaceSolid, hover.Value * 0.4F);
                G.FillRound(g, body, Radius, fill);
            }
            G.DrawRound(g, body, Radius, BorderColor(), 1.1F);

            // ripples
            foreach (Ripple rp in ripples)
            {
                int rad = (int)(rp.T * (Math.Max(r.Width, r.Height) * 0.9F));
                int a = (int)((1F - rp.T) * 120);
                using (SolidBrush b = new SolidBrush(Color.FromArgb(a, rp.Color)))
                    g.FillEllipse(b, rp.X - rad, rp.Y - rad, rad * 2, rad * 2);
            }

            // text
            Color tx = Kind == BtnKind.Primary ? C.OnAccent : (Kind == BtnKind.Danger ? C.Err : C.Text);
            if (Kind == BtnKind.Ghost && hover.Value > 0.01F) tx = G.Mix(C.TextDim, C.Text, hover.Value);
            StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            using (SolidBrush tb = new SolidBrush(!Enabled ? C.TextMute : tx))
                g.DrawString(Text, Font, tb, r, sf);

            if (!Enabled)
            {
                using (GraphicsPath p = G.Round(body, Radius))
                using (SolidBrush b = new SolidBrush(Color.FromArgb(120, 0, 0, 0)))
                    g.FillPath(b, p);
            }
        }

        private Color BorderColor()
        {
            if (Kind == BtnKind.Primary) return Color.FromArgb(128, 255, 255, 255);
            if (Kind == BtnKind.Danger) return C.ErrHi;
            return G.Mix(C.BorderHi, C.BorderNeon, hover.Value);
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hover.To_(1F); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hover.To_(0F); press = 0; }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            press = 1F;
            Color rc = Kind == BtnKind.Primary ? Color.FromArgb(0, 0, 0) : Color.FromArgb(120, 255, 255, 255);
            ripples.Add(new Ripple { X = e.X, Y = e.Y, T = 0F, Color = rc });
            Focus();
        }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); press = 0F; }

        public void Tick(float dt)
        {
            hover.Step(dt);
            press += (0 - press) * Math.Min(1F, 18F * dt);
            bool changed = !hover.Done || Math.Abs(press) > 0.01F || ripples.Count > 0;
            for (int i = ripples.Count - 1; i >= 0; i--)
            {
                Ripple rp = ripples[i];
                rp.T += dt * 1.8F;
                if (rp.T >= 1F) ripples.RemoveAt(i);
                else ripples[i] = rp;
            }
            if (changed) Invalidate();
        }

        private struct Ripple { public float X, Y, T; public Color Color; }
    }

    // ── Checkbox ───────────────────────────────────────────────────────────────
    public sealed class UiCheck : Control
    {
        public bool Checked;
        private Tween hover = new Tween(0F);
        public UiCheck()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Font = F.Body;
            Cursor = Cursors.Hand;
            Size = new Size(260, 28);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle box = new Rectangle(0, (Height - 20) / 2, 20, 20);
            Color fill = Checked ? C.Accent : G.Mix(C.SurfaceHi, C.SurfaceSolid, hover.Value * 0.5F);
            Color bdr = Checked ? C.Accent : G.Mix(C.BorderHi, C.BorderNeon, hover.Value);
            // Radius 6 (not 8): a 20px box with radius 8 is so rounded the
            // checkmark tips land on the curved corner taper and look clipped.
            // 6 keeps the corners tight enough that the tips sit over solid fill.
            G.FillRound(g, box, 6, fill);
            G.DrawRound(g, box, 6, bdr, 1.1F);
            if (Checked)
            {
                // Tips inset toward the box center (away from the rounded
                // corners) so they draw over solid fill, and a round line
                // join so the elbow at the bottom point doesn't spike.
                using (Pen pen = new Pen(C.OnAccent, 2.2F) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                {
                    g.DrawLines(pen, new PointF[] { new PointF(box.X + 6, box.Y + 11), new PointF(box.X + 10, box.Y + 15), new PointF(box.X + 14, box.Y + 7) });
                }
            }
            Rectangle tr = new Rectangle(box.Right + 10, 0, Width - box.Right - 10, Height);
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            using (SolidBrush b = new SolidBrush(C.TextDim))
            {
                StringFormat sf = new StringFormat { LineAlignment = StringAlignment.Center };
                g.DrawString(Text, Font, b, tr, sf);
            }
        }
        protected override void OnMouseEnter(EventArgs e) { hover.To_(1F); }
        protected override void OnMouseLeave(EventArgs e) { hover.To_(0F); }
        protected override void OnClick(EventArgs e) { Checked = !Checked; hover.To_(1F); Invalidate(); if (CheckChanged != null) CheckChanged(this, e); }
        public event EventHandler CheckChanged;
        public void Tick(float dt) { hover.Step(dt); if (!hover.Done) Invalidate(); }
    }

    // ── Titlebar (draggable, custom window controls) ───────────────────────────
    public sealed class Titlebar : Control
    {
        public Action OnMinimize, OnClose;
        private Rectangle btnMin, btnClose;
        private int hoverBtn = -1;
        private Point? drag;
        // Scene time, fed by the form's animation timer each frame so the
        // title bar's starfield twinkles in step with the sidebar.
        public float Time;
        public Titlebar()
        {
            DoubleBuffered = true;
            Height = 40;
            Cursor = Cursors.Default;
        }
        protected override void OnResize(EventArgs e) { btnClose = new Rectangle(Width - 44, 5, 38, 30); btnMin = new Rectangle(Width - 86, 5, 38, 30); Invalidate(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            // Opaque dark bar: the form's baked starfield is hidden behind it so
            // only the title bar's own (cursor-following) stars show — no doubling
            // of a static field under a moving one when the cursor moves.
            using (SolidBrush b = new SolidBrush(Color.FromArgb(255, 5, 5, 7))) g.FillRectangle(b, ClientRectangle);
            // subtle twinkling stars across the title bar (same field as the bg)
            SetupForm.DrawStars(g, Time, ClientRectangle);
            // brand mark — the avatar clipped to a rounded square, or the "E"
            // gradient placeholder when no avatar is embedded.
            Rectangle m = new Rectangle(14, 10, 20, 20);
            Bitmap av = SetupForm.AvatarThumb;
            if (av != null)
            {
                G.GlowRound(g, m, 6, Color.FromArgb(70, C.Accent), 4);
                using (GraphicsPath pp = G.Round(m, 6))
                {
                    Region old = g.Clip;
                    using (Region clip = new Region(pp))
                    {
                        g.Clip = clip;
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.DrawImage(av, m);
                        g.InterpolationMode = InterpolationMode.Default;
                        g.Clip = old;
                    }
                    using (Pen pen = new Pen(C.BorderHi, 1F)) g.DrawPath(pen, pp);
                }
            }
            else
            {
                G.GlowRound(g, m, 6, Color.FromArgb(70, C.Accent), 4);
                using (Brush b = G.AccentBrush(m)) g.FillPath(b, G.Round(m, 6));
                using (SolidBrush b = new SolidBrush(C.OnAccent))
                { StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }; g.DrawString("E", new Font("Segoe UI", 10F, FontStyle.Bold, GraphicsUnit.Pixel), b, m, sf); }
            }
            // brand label, vertically centered on the avatar mark (band y 10..30,
            // center y=20) so the text sits at the same height as the avatar.
            using (SolidBrush b = new SolidBrush(C.TextDim))
            { StringFormat sf = new StringFormat { Alignment = StringAlignment.Near, LineAlignment = StringAlignment.Center }; g.DrawString("EDITOR HELPER", F.SmallB, b, new Rectangle(42, 10, 220, 20), sf); }
            using (SolidBrush b = new SolidBrush(C.TextMute))
            { StringFormat sf = new StringFormat { Alignment = StringAlignment.Near, LineAlignment = StringAlignment.Center }; g.DrawString("Установщик", F.Small, b, new Rectangle(42 + 130, 10, 120, 20), sf); }
            // buttons
            DrawTb(g, btnMin, hoverBtn == 0, false, "−");
            DrawTb(g, btnClose, hoverBtn == 1, true, "✕");
        }
        private void DrawTb(Graphics g, Rectangle r, bool hot, bool close, string glyph)
        {
            if (hot) G.FillRound(g, r, 6, C.SurfaceHi);
            Color col = hot ? C.Text : C.TextDim;
            using (SolidBrush b = new SolidBrush(col))
            { StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }; g.DrawString(glyph, new Font("Segoe UI", 11F, FontStyle.Bold, GraphicsUnit.Pixel), b, r, sf); }
        }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            int nb = -1;
            if (btnMin.Contains(e.Location)) nb = 0;
            else if (btnClose.Contains(e.Location)) nb = 1;
            if (nb != hoverBtn) { hoverBtn = nb; Invalidate(); }
            if (drag.HasValue && Parent != null)
            {
                Parent.Location = new Point(Parent.Location.X + e.X - drag.Value.X, Parent.Location.Y + e.Y - drag.Value.Y);
            }
        }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (btnMin.Contains(e.Location)) { if (OnMinimize != null) OnMinimize(); return; }
            if (btnClose.Contains(e.Location)) { if (OnClose != null) OnClose(); return; }
            // Start a window drag. Keep the cursor as the default arrow —
            // switching to SizeAll looked like a "resize/scale" mode.
            drag = e.Location;
        }
        protected override void OnMouseUp(MouseEventArgs e) { drag = null; }
        protected override void OnMouseLeave(EventArgs e) { hoverBtn = -1; drag = null; Invalidate(); }
    }

    // ── Step rail (left sidebar) ───────────────────────────────────────────────
    public sealed class StepRail : Control
    {
        public string[] Steps;
        public int Current;
        // Scene time, fed by the form's animation timer each frame. The rail
        // paints a living cosmic backdrop from this (parallax stars, drifting
        // nebulae, shooting stars) WITHOUT invalidating the form bg or the
        // content pages — so the background stays dynamic but never laggy.
        public float Time;
        public StepRail() { DoubleBuffered = true; BuildScene(); }

        // ── dynamic scene ──────────────────────────────────────────────────
        private struct SStar { public float X, Y; public int Sz; public float Base, Phase, Speed; }
        private struct Meteor { public float X, Y, Vx, Vy, Life, Max; public int Len; }
        private SStar[][] layers;          // 3 parallax layers (far -> near)
        private float[] layerDrift;        // per-layer drift speed (px/s)
        private Bitmap neb1, neb2;          // cached radial glows (blitted, not rebuilt)
        private List<Meteor> meteors = new List<Meteor>();
        private float spawnT = 2F;
        private Random rnd = new Random(7);
        // Cached static backdrop gradient + steps layer. The rail repaints every
        // frame (its starfield / nebulae / meteors animate), but the gradient and
        // the step circles / connectors / glyphs / labels only change when Current
        // (or the size) changes — so bake them once and blit. Rebuilding them per
        // frame was the bulk of the per-frame cost.
        private Bitmap bgGradBmp, stepsBmp;
        private int stepsBmpCurrent = -1;

        private void BuildScene()
        {
            int[] counts = { 64, 38, 20 };
            float[] drifts = { 5F, 12F, 22F };
            layers = new SStar[3][];
            layerDrift = drifts;
            for (int l = 0; l < 3; l++)
            {
                SStar[] arr = new SStar[counts[l]];
                for (int i = 0; i < arr.Length; i++)
                {
                    arr[i] = new SStar
                    {
                        X = (float)rnd.NextDouble() * 248F,
                        Y = (float)rnd.NextDouble() * 600F,
                        Sz = l == 0 ? 1 : (l == 1 ? (rnd.Next(0, 3) == 0 ? 2 : 1) : 2),
                        Base = (l == 0 ? 36F : (l == 1 ? 95F : 160F)) + (float)rnd.NextDouble() * 45F,
                        Phase = (float)(rnd.NextDouble() * Math.PI * 2.0),
                        Speed = 0.5F + (float)rnd.NextDouble() * 1.9F,
                    };
                }
                layers[l] = arr;
            }
            MakeNebula(out neb1, 120, Color.FromArgb(36, 110, 110, 110));
            MakeNebula(out neb2, 150, Color.FromArgb(28, 80, 80, 80));
        }
        private static void MakeNebula(out Bitmap b, int rad, Color col)
        {
            b = new Bitmap(rad * 2, rad * 2, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
            using (Graphics g = Graphics.FromImage(b))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                Rectangle e = new Rectangle(0, 0, rad * 2, rad * 2);
                using (GraphicsPath p = new GraphicsPath())
                {
                    p.AddEllipse(e);
                    using (PathGradientBrush br = new PathGradientBrush(p))
                    {
                        br.CenterColor = col;
                        br.SurroundColors = new Color[] { Color.FromArgb(0, col.R, col.G, col.B) };
                        g.FillPath(br, p);
                    }
                }
            }
        }
        // Advances meteor state. Called from the form's animation timer each
        // frame (the starfield itself is driven purely by `Time` in OnPaint).
        public void Tick(float dt)
        {
            spawnT -= dt;
            if (spawnT <= 0F)
            {
                spawnT = 2F + (float)rnd.NextDouble() * 4.5F;
                bool down = rnd.Next(2) == 0;
                float vy = (down ? 1F : -1F) * (150F + (float)rnd.NextDouble() * 130F);
                meteors.Add(new Meteor
                {
                    X = (float)rnd.NextDouble() * 260F,
                    Y = down ? -8F : 600F,
                    Vx = 70F + (float)rnd.NextDouble() * 70F,
                    Vy = vy,
                    Life = 0F,
                    Max = 0.65F + (float)rnd.NextDouble() * 0.55F,
                    Len = 26 + rnd.Next(0, 22),
                });
            }
            for (int i = meteors.Count - 1; i >= 0; i--)
            {
                Meteor m = meteors[i];
                m.Life += dt;
                m.X += m.Vx * dt;
                m.Y += m.Vy * dt;
                if (m.Life >= m.Max) meteors.RemoveAt(i);
                else meteors[i] = m;
            }
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (neb1 != null) try { neb1.Dispose(); } catch { }
                if (neb2 != null) try { neb2.Dispose(); } catch { }
                if (bgGradBmp != null) try { bgGradBmp.Dispose(); } catch { }
                if (stepsBmp != null) try { stepsBmp.Dispose(); } catch { }
            }
            base.Dispose(disposing);
        }
        // Lazily build (and resize-rebuild) the static gradient backdrop so OnPaint
        // is a single blit instead of a per-frame LinearGradientBrush + FillRectangle.
        private void EnsureBgGrad(Rectangle bg)
        {
            if (bgGradBmp != null && bgGradBmp.Width == bg.Width && bgGradBmp.Height == bg.Height) return;
            if (bgGradBmp != null) try { bgGradBmp.Dispose(); } catch { }
            if (bg.Width <= 0 || bg.Height <= 0) return;
            bgGradBmp = new Bitmap(bg.Width, bg.Height, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
            using (Graphics g = Graphics.FromImage(bgGradBmp))
            using (LinearGradientBrush lb = new LinearGradientBrush(bg, C.Bg, C.Bg2, 90F))
                g.FillRectangle(lb, bg);
        }
        // Lazily build (and rebuild on Current / size change) the steps layer:
        // circles, connectors, glyphs, labels. It only depends on Current + size,
        // so baking it avoids redrawing all of that (paths, pens, DrawString) every
        // frame. OnPaint blits the cached bitmap over the animated starfield.
        private void EnsureStepsBmp(Rectangle bg)
        {
            if (Steps == null) return;
            bool sizeOk = stepsBmp != null && stepsBmp.Width == bg.Width && stepsBmp.Height == bg.Height;
            if (!sizeOk)
            {
                if (stepsBmp != null) try { stepsBmp.Dispose(); } catch { }
                if (bg.Width <= 0 || bg.Height <= 0) return;
                stepsBmp = new Bitmap(bg.Width, bg.Height, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
                stepsBmpCurrent = -1;
            }
            if (stepsBmpCurrent == Current) return;
            stepsBmpCurrent = Current;
            using (Graphics g = Graphics.FromImage(stepsBmp))
            {
                g.Clear(Color.FromArgb(0, 0, 0, 0));
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                DrawSteps(g);
            }
        }
        private void DrawSteps(Graphics g)
        {
            int y = 90;
            int x = 26;
            int gap = 56;
            for (int i = 0; i < Steps.Length; i++)
            {
                bool done = i < Current;
                bool active = i == Current;
                Rectangle circ = new Rectangle(x, y, 26, 26);
                // connector
                if (i < Steps.Length - 1)
                {
                    Rectangle line = new Rectangle(x + 12, y + 26, 2, gap - 26);
                    Color lc = (i < Current) ? C.Accent : C.BorderHi;
                    using (SolidBrush b = new SolidBrush(lc)) g.FillRectangle(b, line);
                }
                // circle
                Color fill = done ? C.Accent : (active ? C.SurfaceTop : C.SurfaceHi);
                Color bdr = done ? C.Accent : (active ? C.Accent : C.BorderHi);
                if (active) G.GlowRound(g, circ, 13, Color.FromArgb(90, C.Accent), 5);
                G.FillRound(g, circ, 13, fill);
                if (active) { using (Pen p = new Pen(C.Accent, 2F)) g.DrawEllipse(p, circ); }
                else G.DrawRound(g, circ, 13, bdr, 1.1F);
                // glyph
                StringFormat sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                if (done)
                {
                    using (Pen pen = new Pen(C.OnAccent, 2.1F) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                        g.DrawLines(pen, new PointF[] { new PointF(circ.X + 6, circ.Y + 13), new PointF(circ.X + 10, circ.Y + 17), new PointF(circ.X + 18, circ.Y + 8) });
                }
                else
                {
                    Color gc = active ? C.Text : C.TextMute;
                    using (SolidBrush b = new SolidBrush(gc)) g.DrawString((i + 1).ToString(), F.SmallB, b, circ, sf);
                }
                // label
                Color lc2 = active ? C.Text : (done ? C.TextDim : C.TextMute);
                Rectangle tr = new Rectangle(circ.Right + 14, y, Width - circ.Right - 28, 26);
                using (SolidBrush b = new SolidBrush(lc2))
                { StringFormat s2 = new StringFormat { LineAlignment = StringAlignment.Center }; g.DrawString(Steps[i], F.Body, b, tr, s2); }
                y += gap;
            }
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bg = ClientRectangle;
            // Opaque dark gradient — the sidebar is self-contained, not a
            // translucent panel over the form bg. Baked into a bitmap (blit),
            // not rebuilt each frame.
            EnsureBgGrad(bg);
            if (bgGradBmp != null) g.DrawImage(bgGradBmp, 0, 0);
            // drifting nebula glows (cached bitmaps, blitted at a wobbling spot)
            DrawNebula(g, bg, neb1, 0.30F, 0.26F, 0, 120);
            DrawNebula(g, bg, neb2, 0.74F, 0.80F, 1, 150);
            // 3 parallax star layers: each drifts downward at its own speed and
            // twinkles. Far stars are dim/small/slow, near stars bright/large/fast.
            int h = bg.Height;
            int w = bg.Width;
            // Cursor parallax (shared with the form bg via SetupForm.StarOX/Y)
            // so the sidebar's field shifts with the cursor together with the
            // title bar — one moving background, not separate scenes.
            float ox = SetupForm.StarOX, oy = SetupForm.StarOY;
            // One reused brush for all 122 stars (color set per star) — allocating
            // a SolidBrush per star per frame was the bulk of the star cost.
            using (SolidBrush br = new SolidBrush(Color.White))
            for (int l = 0; l < layers.Length; l++)
            {
                SStar[] arr = layers[l];
                float dy = (Time * layerDrift[l]) % h;
                for (int i = 0; i < arr.Length; i++)
                {
                    SStar s = arr[i];
                    float px = s.X + ox;
                    float py = s.Y + dy + oy;
                    if (px < 0) px += w; else if (px >= w) px -= w;
                    if (py > h) py -= h; else if (py < 0) py += h;
                    int b = (int)(s.Base + Math.Sin(s.Phase + Time * s.Speed) * 48);
                    if (b < 18) b = 18; else if (b > 235) b = 235;
                    br.Color = Color.FromArgb(b, 240, 240, 240);
                    if (s.Sz <= 1) g.FillRectangle(br, px, py, 1, 1);
                    else g.FillEllipse(br, px, py, s.Sz, s.Sz);
                }
            }
            // shooting stars — bright streaks fading in then out
            foreach (Meteor m in meteors)
            {
                float a = m.Life / m.Max;
                int alpha = (int)((1F - Math.Abs(a - 0.5F) * 2F) * 210);
                if (alpha <= 0) continue;
                float norm = (float)Math.Sqrt(m.Vx * m.Vx + m.Vy * m.Vy);
                float dx = m.Vx / norm * m.Len, dy2 = m.Vy / norm * m.Len;
                using (Pen p = new Pen(Color.FromArgb(alpha, 245, 245, 250), 1.6F) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                    g.DrawLine(p, m.X, m.Y, m.X - dx, m.Y - dy2);
            }
            // steps layer (circles / connectors / glyphs / labels) — cached,
            // rebuilt only when Current or size changes, then blitted.
            EnsureStepsBmp(bg);
            if (stepsBmp != null) g.DrawImage(stepsBmp, 0, 0);
        }
        // Blits a cached nebula glow at a slowly wobbling spot so the cloud
        // drifts over ~tens of seconds. Cheaper than rebuilding a
        // PathGradientBrush every frame.
        private void DrawNebula(Graphics g, Rectangle area, Bitmap bmp, float fx, float fy, int idx, int rad)
        {
            if (bmp == null) return;
            float wx = (float)Math.Sin(Time * 0.11F + idx) * 20F;
            float wy = (float)Math.Cos(Time * 0.08F + idx * 1.7F) * 16F;
            int cx = (int)(area.X + area.Width * fx + wx + SetupForm.StarOX);
            int cy = (int)(area.Y + area.Height * fy + wy + SetupForm.StarOY);
            g.DrawImage(bmp, cx - rad, cy - rad);
        }
    }

    // ── Progress bar with shimmer ───────────────────────────────────────────────
    public sealed class UiProgress : Control
    {
        public float Value; // 0..100
        private float display;
        private float shimmer;
        public UiProgress()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.ResizeRedraw | ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Height = 12;
        }
        public void Tick(float dt)
        {
            float prev = display;
            display += (Value - display) * Math.Min(1F, 9F * dt);
            shimmer += dt;
            // Only repaint when something actually changes: the bar is lerping
            // toward its target, or a fill is present (shimmer visible). Idle at
            // 0 must not invalidate every frame.
            if (Math.Abs(display - prev) > 0.05F || display > 0.5F) Invalidate();
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle r = ClientRectangle; r.Height -= 1;
            G.FillRound(g, r, 6, C.SurfaceHi);
            G.DrawRound(g, r, 6, C.Border, 1F);
            if (display <= 0.1F) return;
            int w = (int)(r.Width * display / 100F);
            if (w < 4) w = 4;
            Rectangle fill = new Rectangle(r.X, r.Y, w, r.Height);
            using (GraphicsPath p = G.Round(fill, 6))
            using (Brush b = G.AccentBrush(fill)) g.FillPath(b, p);
            // shimmer sweep
            float sx = (shimmer % 1.6F) / 1.6F;
            int sweepX = (int)(sx * (w + 60)) - 30;
            using (GraphicsPath p = G.Round(fill, 6))
            {
                Region old = g.Clip; using (Region clip = new Region(p)) { g.Clip = clip;
                    Rectangle sr = new Rectangle(r.X + sweepX, r.Y, 30, r.Height);
                    using (LinearGradientBrush lb = new LinearGradientBrush(sr, Color.FromArgb(0, 255, 255, 255), Color.FromArgb(110, 255, 255, 255), 0F))
                        g.FillRectangle(lb, sr);
                    g.Clip = old; }
            }
        }
    }

    // ── Double-buffered panel — flicker-free container for pages/bar ──────────
    // Plain Panel flickers when moved (page slide) or when a transparent child
    // repaints, because it paints directly to screen without a back buffer.
    public sealed class DbPanel : Panel
    {
        public DbPanel()
        {
            DoubleBuffered = true;
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true);
        }
    }

    // ── Scrollable text view with a thin custom scrollbar ─────────────────────
    // Replaces the white Windows RichTextBox (license) and ListBox (install log):
    // wraps text, supports mouse wheel + thumb drag, fades the scrollbar out.
    public sealed class ScrollTextView : Control
    {
        private List<string> src = new List<string>();
        private List<string> vis = new List<string>();   // wrapped
        private float scroll, maxScroll;
        private int lineH;
        private float sbA;            // scrollbar alpha 0..1
        private bool sbHot, drag;
        private int dragY0; private float dragScroll0;
        private bool dirty = true;

        public ScrollTextView()
        {
            DoubleBuffered = true;
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Font = F.Mono;
            Cursor = Cursors.Default;
        }

        public void SetText(string text)
        {
            src.Clear();
            if (!string.IsNullOrEmpty(text))
                src.AddRange(text.Replace("\r\n", "\n").Replace("\r", "\n").Split('\n'));
            dirty = true; Invalidate();
        }
        public void Append(string line)
        {
            src.Add(line ?? "");
            if (src.Count > 400) src.RemoveRange(0, src.Count - 400);
            // auto-stick to the bottom when already near it (log tail behavior)
            bool stick = scroll >= maxScroll - lineH * 0.6F;
            dirty = true;
            if (stick) scroll = float.MaxValue;   // clamped back inside Relayout
            Invalidate();
        }
        public void Clear() { src.Clear(); scroll = 0; maxScroll = 0; dirty = true; Invalidate(); }

        private void Relayout(Graphics g)
        {
            lineH = (int)Math.Ceiling(g.MeasureString("Ay", Font, int.MaxValue, StringFormat.GenericDefault).Height) + 5;
            vis.Clear();
            int wrapW = Width - 22;
            if (wrapW < 10) wrapW = 10;
            foreach (string raw in src)
            {
                if (raw.Length == 0) { vis.Add(""); continue; }
                float w = g.MeasureString(raw, Font, int.MaxValue, StringFormat.GenericDefault).Width;
                if (w <= wrapW) { vis.Add(raw); continue; }
                // word wrap
                string[] words = raw.Split(' ');
                string cur = "";
                for (int i = 0; i < words.Length; i++)
                {
                    string test = cur.Length == 0 ? words[i] : cur + " " + words[i];
                    float tw = g.MeasureString(test, Font, int.MaxValue, StringFormat.GenericDefault).Width;
                    if (tw > wrapW && cur.Length > 0) { vis.Add(cur); cur = words[i]; }
                    else cur = test;
                }
                if (cur.Length > 0) vis.Add(cur);
            }
            int total = vis.Count * lineH;
            maxScroll = Math.Max(0, total - Height + 6);
            if (scroll > maxScroll) scroll = maxScroll;
            if (scroll < 0) scroll = 0;
            dirty = false;
        }

        private float ThumbH { get { return Math.Max(30F, Height * (float)Height / Math.Max(1, vis.Count * lineH)); } }
        private Rectangle ThumbRect
        {
            get
            {
                float th = ThumbH;
                float ty = maxScroll <= 0 ? 0 : (Height - th) * (scroll / maxScroll);
                return new Rectangle(Width - 10, (int)ty, 6, (int)th);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            if (dirty || vis.Count == 0) Relayout(g);
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            float y = -scroll;
            using (SolidBrush br = new SolidBrush(C.TextDim))
            {
                foreach (string ln in vis)
                {
                    if (y + lineH >= -1 && y < Height)
                        g.DrawString(ln, Font, br, 2, y);
                    y += lineH;
                    if (y > Height + lineH) break;
                }
            }
            if (maxScroll > 0)
            {
                float a = Math.Max(sbA, (sbHot || drag) ? 1F : 0F);
                if (a > 0.01F)
                {
                    Rectangle tr = ThumbRect;
                    Color tc = Color.FromArgb((int)(a * 170), 190, 190, 200);
                    G.FillRound(g, tr, 3, tc);
                }
            }
        }

        public void Tick(float dt)
        {
            float target = (sbHot || drag) ? 1F : 0F;
            float prev = sbA;
            sbA += (target - sbA) * Math.Min(1F, 10F * dt);
            if (sbA <= 0.001F) sbA = 0;
            if (Math.Abs(sbA - prev) > 0.01F) Invalidate();
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            scroll -= e.Delta * 0.5F;
            if (scroll < 0) scroll = 0;
            if (scroll > maxScroll) scroll = maxScroll;
            sbA = 1F;
            Invalidate();
            try { ((HandledMouseEventArgs)e).Handled = true; } catch { }
            base.OnMouseWheel(e);
        }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (drag)
            {
                float th = ThumbH;
                float span = Height - th;
                if (span <= 0) return;
                scroll = dragScroll0 + (e.Y - dragY0) / span * maxScroll;
                if (scroll < 0) scroll = 0;
                if (scroll > maxScroll) scroll = maxScroll;
                Invalidate();
                return;
            }
            bool hot = ThumbRect.Contains(e.Location);
            if (hot != sbHot) { sbHot = hot; Cursor = hot ? Cursors.Hand : Cursors.Default; Invalidate(); }
        }
        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (ThumbRect.Contains(e.Location))
            {
                drag = true; dragY0 = e.Y; dragScroll0 = scroll; sbA = 1F;
                Invalidate(); return;
            }
            if (e.X >= Width - 14)
            {
                float page = Height * 0.8F;
                scroll += (e.Y < ThumbRect.Y ? -page : page);
                if (scroll < 0) scroll = 0;
                if (scroll > maxScroll) scroll = maxScroll;
                sbA = 1F; Invalidate();
            }
        }
        protected override void OnMouseUp(MouseEventArgs e) { drag = false; Invalidate(); }
        protected override void OnMouseLeave(EventArgs e) { sbHot = false; drag = false; Cursor = Cursors.Default; Invalidate(); }
        protected override void OnResize(EventArgs e) { dirty = true; Invalidate(); base.OnResize(e); }
    }
}