---
name: css-layout
description: Create responsive CSS layouts using flexbox, grid, media queries, container queries, and modern CSS patterns for cards, dashboards, navbars, and holy grail layouts
---

# CSS Layout Skill

Master responsive CSS layouts using modern techniques. Build flexible, accessible designs that adapt to any screen size.

## Approach

### 1. Layout Foundation
- **Flexbox**: One-dimensional layouts, alignment, distribution
- **CSS Grid**: Two-dimensional layouts, complex arrangements
- **Container Queries**: Size-based responsive design (modern alternative to media queries)
- **Media Queries**: Breakpoint-based responsive design
- **Modern Patterns**: Holy grail, cards, dashboards, navbars

### 2. Design Strategy
- Mobile-first: Start with mobile, enhance for larger screens
- Semantic HTML: Use proper structure (header, main, aside, footer)
- Accessibility: Ensure focus states, semantic landmarks, readable contrast
- Performance: Minimize reflow/repaint with efficient selectors

### 3. Common Patterns
- **Cards**: Grid of responsive cards with consistent sizing
- **Dashboards**: Multi-column layouts with flexible widgets
- **Navbars**: Responsive navigation with mobile menu
- **Holy Grail**: Header, footer, sidebar, main content layout
- **Masonry**: CSS grid with auto-placement

## Templates

### Flexbox Container
```css
.flex-container {
  display: flex;
  flex-direction: row; /* or column */
  justify-content: space-between; /* flex-start, center, flex-end, space-around */
  align-items: center; /* flex-start, center, flex-end, stretch */
  gap: 1rem;
  flex-wrap: wrap;
}

.flex-item {
  flex: 1; /* flex-grow flex-shrink flex-basis */
  min-width: 0; /* prevent overflow */
}
```

### CSS Grid Container
```css
.grid-container {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  grid-template-rows: auto 1fr auto;
  gap: 1rem;
  grid-auto-flow: dense; /* optional: fill gaps */
}

.grid-item {
  grid-column: span 1; /* or specific start/end */
  grid-row: span 1;
}
```

### Responsive Card Grid
```css
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.5rem;
  padding: 1rem;
}

.card {
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.card-body {
  flex: 1;
  padding: 1.5rem;
}

.card-footer {
  padding: 1rem 1.5rem;
  border-top: 1px solid #eee;
}
```

### Holy Grail Layout
```css
html, body {
  height: 100%;
  margin: 0;
}

body {
  display: grid;
  grid-template-columns: 200px 1fr 200px;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    "header header header"
    "sidebar main aside"
    "footer footer footer";
  gap: 1rem;
  min-height: 100vh;
}

header {
  grid-area: header;
  background: #333;
  color: white;
  padding: 1rem;
}

aside {
  grid-area: sidebar;
  background: #f5f5f5;
  padding: 1rem;
  overflow-y: auto;
}

main {
  grid-area: main;
  padding: 1rem;
  overflow-y: auto;
}

nav.secondary {
  grid-area: aside;
  background: #f5f5f5;
  padding: 1rem;
}

footer {
  grid-area: footer;
  background: #333;
  color: white;
  padding: 1rem;
  text-align: center;
}

@media (max-width: 768px) {
  body {
    grid-template-columns: 1fr;
    grid-template-areas:
      "header"
      "main"
      "footer";
  }
  aside, nav.secondary {
    display: none;
  }
}
```

### Responsive Navbar
```css
nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 2rem;
  background: #333;
  color: white;
}

.nav-brand {
  font-size: 1.5rem;
  font-weight: bold;
}

.nav-links {
  display: flex;
  list-style: none;
  gap: 2rem;
  margin: 0;
  padding: 0;
}

.nav-links a {
  color: white;
  text-decoration: none;
  transition: color 0.3s;
}

.nav-links a:hover {
  color: #ffd700;
}

.hamburger {
  display: none;
  flex-direction: column;
  cursor: pointer;
}

.hamburger span {
  width: 25px;
  height: 3px;
  background: white;
  margin: 5px 0;
  transition: 0.3s;
}

@media (max-width: 768px) {
  .hamburger {
    display: flex;
  }
  
  .nav-links {
    position: absolute;
    top: 60px;
    left: 0;
    right: 0;
    flex-direction: column;
    gap: 0;
    background: #333;
    max-height: 0;
    overflow: hidden;
    transition: max-height 0.3s;
  }
  
  .nav-links.active {
    max-height: 300px;
  }
  
  .nav-links a {
    padding: 1rem 2rem;
    border-bottom: 1px solid #555;
  }
}
```

### Container Query Pattern
```css
.container {
  container-type: inline-size;
  padding: 1rem;
}

.responsive-component {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
}

@container (min-width: 400px) {
  .responsive-component {
    grid-template-columns: 1fr 1fr;
  }
}

@container (min-width: 800px) {
  .responsive-component {
    grid-template-columns: 1fr 1fr 1fr;
  }
}
```

### Dashboard Layout
```css
.dashboard {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  grid-auto-rows: minmax(200px, auto);
  gap: 1.5rem;
  padding: 2rem;
}

.widget {
  background: white;
  border-radius: 8px;
  padding: 1.5rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.widget.large {
  grid-column: span 2;
}

.widget.tall {
  grid-row: span 2;
}

.widget-title {
  font-size: 1.1rem;
  font-weight: bold;
  margin-bottom: 1rem;
  border-bottom: 2px solid #007bff;
  padding-bottom: 0.5rem;
}

@media (max-width: 768px) {
  .dashboard {
    grid-template-columns: 1fr;
  }
  
  .widget.large {
    grid-column: span 1;
  }
}
```

## Checklists

### Before Building
- [ ] Define breakpoints (mobile: <768px, tablet: 768-1024px, desktop: >1024px)
- [ ] Choose layout method (flexbox vs grid vs combination)
- [ ] Plan mobile-first approach
- [ ] Identify fixed vs flexible components
- [ ] Plan spacing/gap strategy (use CSS variables for consistency)
- [ ] Consider accessibility (keyboard nav, focus states, semantic HTML)

### Layout Implementation
- [ ] Set up HTML with semantic structure
- [ ] Apply base layout with flexbox or grid
- [ ] Set appropriate gaps and padding
- [ ] Handle overflow with min-width: 0 for flex items
- [ ] Add media queries for breakpoints
- [ ] Test on multiple screen sizes
- [ ] Verify content doesn't overflow containers
- [ ] Check text readability at all sizes
- [ ] Ensure touch targets are ≥44px on mobile

### Responsive Design
- [ ] Mobile layout (single column, stacked)
- [ ] Tablet layout (2-3 columns)
- [ ] Desktop layout (full width optimized)
- [ ] Test common viewport sizes (375px, 768px, 1024px, 1440px)
- [ ] Use container queries for self-contained components
- [ ] Avoid magic numbers, use consistent spacing scale
- [ ] Optimize images for different densities (srcset)

### Accessibility & Performance
- [ ] Test keyboard navigation (Tab order makes sense)
- [ ] Check color contrast (WCAG AA minimum)
- [ ] Add focus indicators to interactive elements
- [ ] Use CSS Grid/Flexbox over floats
- [ ] Minimize nested selectors (performance)
- [ ] Avoid position: absolute for layouts
- [ ] Test with screen readers
- [ ] Validate HTML structure

### Common Issues & Solutions
| Issue | Solution |
|-------|----------|
| Text overflow in flex items | Add `min-width: 0` or `overflow: hidden` |
| Grid gaps not responsive | Use CSS variables: `gap: clamp(0.5rem, 2vw, 2rem)` |
| Navbar overlaps content | Use `padding-top` on body or `position: sticky` |
| Images break layout | Set `max-width: 100%; height: auto` |
| Media queries not triggering | Check viewport meta tag in HTML |
| Cards have different heights | Use `align-items: stretch` or `min-height` |

## Resources
- MDN Flexbox Guide: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Flexible_Box_Layout
- MDN Grid Guide: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Grid_Layout
- Container Queries: https://developer.mozilla.org/en-US/docs/Web/CSS/Container_queries
- Responsive Design Patterns: https://web.dev/responsive-web-design-basics/
