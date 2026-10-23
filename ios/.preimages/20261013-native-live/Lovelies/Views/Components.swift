import SwiftUI
import UIKit

enum LoveliesTheme {
    static let canvas = Color(red: 9 / 255, green: 9 / 255, blue: 11 / 255)
    static let surface = Color(red: 27 / 255, green: 28 / 255, blue: 30 / 255)
    static let raised = Color(red: 37 / 255, green: 38 / 255, blue: 40 / 255)
    static let pink = Color(red: 1, green: 144 / 255, blue: 181 / 255)
    static let secondary = Color.white.opacity(0.68)
    static let stroke = Color.white.opacity(0.13)
}

struct AssetImage: View {
    let name: String
    private var loadedImage: UIImage? {
        var paths = [name, "Resources/\(name)"]
        if (name as NSString).pathExtension.isEmpty {
            for ext in ["jpg", "png", "jpeg"] { paths += ["\(name).\(ext)", "Resources/\(name).\(ext)"] }
        }
        return paths.lazy.compactMap { UIImage(named: $0) }.first
    }
    var body: some View {
        if let value = loadedImage {
            Image(uiImage: value).resizable()
        } else {
            Rectangle().fill(LoveliesTheme.raised).overlay(Image(systemName: "photo").foregroundStyle(LoveliesTheme.secondary))
        }
    }
}

struct Wordmark: View {
    @EnvironmentObject private var store: DemoStore
    var width: CGFloat = 180
    var body: some View {
        AssetImage(name: "wordmark").scaledToFit().frame(width: width)
            .accessibilityLabel("Lovelies")
            .onLongPressGesture { store.showGallery = true }
    }
}

struct GlowBackground: View {
    var strong = false
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                LoveliesTheme.canvas
                ForEach(0..<9) { index in
                    Circle().fill(LoveliesTheme.pink.opacity(index.isMultiple(of: 2) ? 0.19 : 0.1))
                        .frame(width: CGFloat(index.isMultiple(of: 3) ? 100 : 50))
                        .blur(radius: CGFloat(strong ? 12 : 24))
                        .position(x: geometry.size.width * [0.02, 0.35, 0.82, 0.08, 0.92, 0.2, 0.73, 0.03, 0.85][index], y: geometry.size.height * [0.24, 0.2, 0.12, 0.6, 0.82, 0.94, 0.64, 0.4, 0.48][index])
                }
            }
        }.ignoresSafeArea().accessibilityHidden(true)
    }
}

struct PageHeader: View {
    @EnvironmentObject private var store: DemoStore
    var title: String
    var subtitle: String? = nil
    var close = false
    var trailing = true
    var leadingTitle = false
    var back = true
    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            if back {
                Button { store.back() } label: { Image(systemName: close ? "xmark" : "chevron.left").font(.system(size: 21, weight: .regular)).frame(width: 34, height: 42) }
                    .accessibilityLabel(close ? "Close" : "Back")
            }
            if leadingTitle {
                Text(title).font(.system(size: 24, weight: .semibold))
                Spacer(minLength: 0)
            } else {
                VStack(spacing: 4) {
                    Text(title).font(.system(size: 19, weight: .semibold)).multilineTextAlignment(.center)
                    if let subtitle { Text(subtitle).font(.system(size: 14)).foregroundStyle(LoveliesTheme.secondary) }
                }.frame(maxWidth: .infinity)
            }
            if trailing { OverflowMenu() }
            else if !leadingTitle, back { Color.clear.frame(width: 34, height: 42) }
        }.foregroundStyle(.white).padding(.horizontal, 13).padding(.top, 3).padding(.bottom, 7)
        .contentShape(Rectangle()).onLongPressGesture { store.showGallery = true }
    }
}

struct OverflowMenu: View {
    @EnvironmentObject private var store: DemoStore
    var body: some View {
        Menu {
            Button("Select photos to share", systemImage: "square.and.arrow.up") { store.go(.shareSelection) }
            Button("Add photos", systemImage: "plus") { store.go(.uploadEntry) }
            Button("Activity", systemImage: "clock") { store.go(.activity) }
            Button("Profile & settings", systemImage: "person.crop.circle") { store.go(.profile) }
            Button("Manage your face", systemImage: "face.smiling") { store.go(.faceManagement) }
            Button("Manage people", systemImage: "person.2") { store.go(.allowedPeople) }
            Button("Privacy & sharing", systemImage: "lock") { store.go(.privacy) }
            Button("Photo access", systemImage: "photo") { store.go(.photoAccessSettings) }
            Button("Notification settings", systemImage: "bell") { store.go(.notificationSettings) }
            Button("Storage", systemImage: "internaldrive") { store.go(.storage) }
            Button("Export your data", systemImage: "square.and.arrow.down") { store.go(.exportData) }
            Button("Account & security", systemImage: "shield") { store.go(.security) }
            Button("Help center", systemImage: "questionmark.circle") { store.go(.help) }
            Button("Shared history", systemImage: "clock.arrow.circlepath") { store.go(.sharedHistory) }
            Button("Report incorrect match", systemImage: "flag") { store.go(.incorrectMatch) }
            Divider()
            Button("Screen gallery · 48 screens", systemImage: "rectangle.grid.2x2") { store.showGallery = true }
        } label: { Image(systemName: "ellipsis").font(.system(size: 17, weight: .semibold)).frame(width: 36, height: 36).background(.white.opacity(0.08), in: Circle()) }
        .accessibilityLabel("More options")
    }
}

struct PinkButton: View {
    var title: String
    var icon: String? = nil
    var enabled = true
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let icon { Image(systemName: icon).font(.system(size: 20, weight: .medium)) }
                Text(title).font(.system(size: 16, weight: .semibold))
            }.frame(maxWidth: .infinity).frame(minHeight: 49)
                .foregroundStyle(Color.black.opacity(0.93))
                .background(LoveliesTheme.pink.opacity(enabled ? 1 : 0.35), in: Capsule())
                .shadow(color: LoveliesTheme.pink.opacity(enabled ? 0.13 : 0), radius: 12)
        }.buttonStyle(.plain).disabled(!enabled)
    }
}

struct QuietButton: View {
    var title: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(LoveliesTheme.secondary)
                .frame(maxWidth: .infinity).frame(minHeight: 47)
                .background(LoveliesTheme.surface, in: Capsule())
                .overlay(Capsule().stroke(LoveliesTheme.stroke, lineWidth: 1))
        }.buttonStyle(.plain)
    }
}

struct Avatar: View {
    var asset: String
    var size: CGFloat = 50
    var pink = false
    var body: some View {
        AssetImage(name: asset).scaledToFill().frame(width: size, height: size).clipShape(Circle())
            .overlay(Circle().stroke(pink ? LoveliesTheme.pink : Color.white.opacity(0.6), lineWidth: pink ? 2 : 1))
            .shadow(color: pink ? LoveliesTheme.pink.opacity(0.35) : .clear, radius: 7)
    }
}

struct CheckBadge: View {
    var selected = true
    var heart = false
    var size: CGFloat = 29
    var body: some View {
        ZStack {
            Circle().fill(selected ? LoveliesTheme.pink : Color.black.opacity(0.15))
            if selected { Image(systemName: heart ? "heart.fill" : "checkmark").font(.system(size: size * 0.46, weight: .semibold)).foregroundStyle(.black) }
            else { Circle().stroke(Color.white.opacity(0.75), lineWidth: 1.4) }
        }.frame(width: size, height: size).shadow(color: selected ? LoveliesTheme.pink.opacity(0.25) : .clear, radius: 5)
        .accessibilityHidden(true)
    }
}

struct PhotoTile: View {
    var photo: DemoPhoto
    var height: CGFloat? = nil
    var selected: Bool? = nil
    var heart = false
    var people = false
    var badgeAction: (() -> Void)? = nil
    var action: () -> Void
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button(action: action) {
                GeometryReader { geometry in
                    AssetImage(name: photo.asset).scaledToFill().frame(width: geometry.size.width, height: geometry.size.height).clipped()
                .overlay(alignment: .topTrailing) { if let selected, badgeAction == nil { CheckBadge(selected: selected, heart: heart).padding(6) } }
                .overlay(alignment: .bottomTrailing) {
                    if people { Image(systemName: "person.2.fill").font(.system(size: 15)).padding(6).background(.black.opacity(0.32), in: Circle()).padding(6) }
                }
                .clipShape(RoundedRectangle(cornerRadius: 11))
                }
            }.buttonStyle(.plain).accessibilityLabel("Photo \(photo.id), \(photo.tags)")
            .accessibilityAddTraits(selected == true ? .isSelected : [])
            if let selected, let badgeAction {
                Button(action: badgeAction) { CheckBadge(selected: selected, heart: heart).padding(6) }
                    .buttonStyle(.plain).accessibilityLabel(heart ? (selected ? "Remove from favorites" : "Add to favorites") : "Change photo selection")
            }
        }.frame(height: height)
    }
}

struct MasonryPhotos: View {
    var photos = DemoPhoto.all
    var columns = 3
    var selected: Set<Int>? = nil
    var showOnlySelectedBadges = false
    var heart = false
    var people = false
    var heightScale: CGFloat = 1
    var badgeAction: ((DemoPhoto) -> Void)? = nil
    var action: (DemoPhoto) -> Void
    var body: some View {
        MasonryLayout(columns: columns) {
            ForEach(photos) { photo in
                PhotoTile(photo: photo, selected: badge(for: photo), heart: heart, people: people && photo.id.isMultiple(of: 3), badgeAction: badgeAction.map { callback in { callback(photo) } }) { action(photo) }
                    .layoutValue(key: PhotoRatioKey.self, value: photo.ratio * heightScale)
            }
        }
    }
    private func badge(for photo: DemoPhoto) -> Bool? {
        guard let selected else { return nil }
        let picked = selected.contains(photo.id)
        return showOnlySelectedBadges && !picked ? nil : picked
    }
}

private struct PhotoRatioKey: LayoutValueKey { static let defaultValue: CGFloat = 1 }

private struct MasonryLayout: Layout {
    var columns: Int
    var gap: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 390
        let itemWidth = max(1, (width - CGFloat(columns - 1) * gap) / CGFloat(columns))
        var heights = Array(repeating: CGFloat.zero, count: columns)
        for view in subviews {
            let column = heights.enumerated().min(by: { $0.element < $1.element })?.offset ?? 0
            heights[column] += itemWidth * view[PhotoRatioKey.self] + gap
        }
        return CGSize(width: width, height: max(0, (heights.max() ?? 0) - gap))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let width = max(1, (bounds.width - CGFloat(columns - 1) * gap) / CGFloat(columns))
        var heights = Array(repeating: CGFloat.zero, count: columns)
        for view in subviews {
            let column = heights.enumerated().min(by: { $0.element < $1.element })?.offset ?? 0
            let height = width * view[PhotoRatioKey.self]
            view.place(at: CGPoint(x: bounds.minX + CGFloat(column) * (width + gap), y: bounds.minY + heights[column]), proposal: ProposedViewSize(width: width, height: height))
            heights[column] += height + gap
        }
    }
}

struct BottomNavigation: View {
    @EnvironmentObject private var store: DemoStore
    var active: Screen
    var compact = false
    private var destinations: [(String, String, Screen)] {
        compact ? [("house", "Home", .home), ("magnifyingglass", "Search", .search), ("heart", "Favorites", .favorites), ("person", "Profile", .profile)] :
        [("house", "Home", .home), ("person.2", "Matches", .newMatches), ("photo", "Photos", .allPhotos), ("heart", "Favorites", .favorites), ("person", "Profile", .profile)]
    }
    var body: some View {
        HStack {
            ForEach(Array(destinations.enumerated()), id: \.offset) { _, item in
                Button { store.go(item.2) } label: {
                    Image(systemName: active == item.2 ? selectedIcon(item.0) : item.0)
                        .font(.system(size: 23, weight: .regular)).frame(maxWidth: .infinity).frame(height: 54)
                        .foregroundStyle(active == item.2 ? LoveliesTheme.pink : .white.opacity(0.82))
                        .shadow(color: active == item.2 ? LoveliesTheme.pink : .clear, radius: 12)
                }.accessibilityLabel(item.1).accessibilityAddTraits(active == item.2 ? .isSelected : [])
            }
        }.padding(.horizontal, 8).background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().stroke(.white.opacity(0.13), lineWidth: 1))
            .padding(.horizontal, 12).padding(.bottom, 3)
    }
    private func selectedIcon(_ symbol: String) -> String {
        if ["house", "person", "heart"].contains(symbol) { return symbol + ".fill" }
        return symbol == "person.2" ? "person.2.fill" : symbol
    }
}

struct SegmentPills: View {
    var values: [String]
    @Binding var selected: String
    var body: some View {
        HStack(spacing: 7) {
            ForEach(values, id: \.self) { value in
                Button { selected = value } label: {
                    Text(value).font(.system(size: 14, weight: selected == value ? .semibold : .regular))
                        .foregroundStyle(selected == value ? .black : .white)
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(selected == value ? LoveliesTheme.pink : LoveliesTheme.surface, in: Capsule())
                }.buttonStyle(.plain).accessibilityAddTraits(selected == value ? .isSelected : [])
            }
        }
    }
}

struct SettingsRow: View {
    var icon: String
    var title: String
    var subtitle: String? = nil
    var value: String? = nil
    var tint = Color.white
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 22)).frame(width: 29).foregroundStyle(tint)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.system(size: 15)).foregroundStyle(tint)
                    if let subtitle { Text(subtitle).font(.system(size: 12)).foregroundStyle(LoveliesTheme.secondary) }
                }
                Spacer(minLength: 2)
                if let value { Text(value).font(.system(size: 12)).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.trailing) }
                Image(systemName: "chevron.right").font(.system(size: 14)).foregroundStyle(LoveliesTheme.secondary)
            }.padding(.horizontal, 15).padding(.vertical, 15).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

struct GroupSurface<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View { VStack(spacing: 0) { content }.background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 16)).overlay(RoundedRectangle(cornerRadius: 16).stroke(LoveliesTheme.stroke, lineWidth: 0.6)) }
}

struct RingHero: View {
    var symbol = "checkmark"
    var portrait: String? = nil
    var size: CGFloat = 170
    var progress: Double? = nil
    var body: some View {
        ZStack {
            ForEach(0..<20) { index in
                let angle = Double(index) * .pi * 2 / 20
                Image(systemName: index.isMultiple(of: 3) ? "sparkle" : "circle.fill")
                    .font(.system(size: index.isMultiple(of: 3) ? 9 : 4))
                    .foregroundStyle(LoveliesTheme.pink.opacity(index.isMultiple(of: 4) ? 0.45 : 0.9))
                    .offset(x: CGFloat(cos(angle)) * (size / 2 + 24), y: CGFloat(sin(angle)) * (size / 2 + 24))
            }
            Circle().stroke(LoveliesTheme.pink.opacity(0.15), lineWidth: 5)
            Circle().trim(from: 0, to: progress.map { CGFloat(max(0.1, $0)) } ?? 1)
                .stroke(LoveliesTheme.pink, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .rotationEffect(.degrees(-90)).shadow(color: LoveliesTheme.pink.opacity(0.7), radius: 13)
            if let portrait { Avatar(asset: portrait, size: size - 28) }
            else { Image(systemName: symbol).font(.system(size: size * 0.42, weight: .bold)).foregroundStyle(LoveliesTheme.pink).shadow(color: LoveliesTheme.pink.opacity(0.8), radius: 15) }
        }.frame(width: size, height: size).padding(26)
    }
}

struct PhotoHeart: View {
    var size: CGFloat = 160
    var body: some View { AssetImage(name: "photo-heart").scaledToFit().frame(width: size, height: size).shadow(color: LoveliesTheme.pink.opacity(0.18), radius: 20) }
}

struct FaceBrackets: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let length = rect.width * 0.17
        let curve: CGFloat = 14
        path.move(to: CGPoint(x: length, y: 0)); path.addLine(to: CGPoint(x: curve, y: 0)); path.addQuadCurve(to: CGPoint(x: 0, y: curve), control: .zero); path.addLine(to: CGPoint(x: 0, y: length))
        path.move(to: CGPoint(x: rect.maxX - length, y: 0)); path.addLine(to: CGPoint(x: rect.maxX - curve, y: 0)); path.addQuadCurve(to: CGPoint(x: rect.maxX, y: curve), control: CGPoint(x: rect.maxX, y: 0)); path.addLine(to: CGPoint(x: rect.maxX, y: length))
        path.move(to: CGPoint(x: 0, y: rect.maxY - length)); path.addLine(to: CGPoint(x: 0, y: rect.maxY - curve)); path.addQuadCurve(to: CGPoint(x: curve, y: rect.maxY), control: CGPoint(x: 0, y: rect.maxY)); path.addLine(to: CGPoint(x: length, y: rect.maxY))
        path.move(to: CGPoint(x: rect.maxX - length, y: rect.maxY)); path.addLine(to: CGPoint(x: rect.maxX - curve, y: rect.maxY)); path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.maxY - curve), control: CGPoint(x: rect.maxX, y: rect.maxY)); path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - length))
        return path
    }
}

struct DemoSheet<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView { VStack(alignment: .leading, spacing: 20) { content }.padding(22) }
                .background(LoveliesTheme.canvas)
                .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }.preferredColorScheme(.dark).presentationDetents([.medium, .large])
    }
}

struct SourceReferenceTile: Decodable, Identifiable {
    let id: Int
    var asset: String
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
    let selected: Bool?
    let controlBaked: Bool?
    let controlBounds: [CGFloat]?
    let peopleBadge: Bool?
    let peopleBadgeBounds: [CGFloat]?
    let badgeX: CGFloat?
    let badgeY: CGFloat?
    let badgeSize: CGFloat?
    let badgeKind: String?
    let badgeOutlined: Bool?
}

struct SourceReferenceLayout: Decodable {
    let sourceBounds: [CGFloat]
    var tiles: [SourceReferenceTile]
    let cameraAsset: String?
    let cameraSourceBounds: [CGFloat]?
    let recentAssets: [String]?
    var aspectRatio: CGFloat {
        guard sourceBounds.count == 4 else { return 1 }
        return max(1, sourceBounds[2] - sourceBounds[0]) / max(1, sourceBounds[3] - sourceBounds[1])
    }
}

enum SourceReferenceCatalog {
    static let layouts: [String: SourceReferenceLayout] = {
        let url = Bundle.main.url(forResource: "reference-grids", withExtension: "json") ?? Bundle.main.url(forResource: "reference-grids", withExtension: "json", subdirectory: "Resources")
        guard let url, let data = try? Data(contentsOf: url), let layouts = try? JSONDecoder().decode([String: SourceReferenceLayout].self, from: data) else { return [:] }
        return layouts
    }()
    static func layout(_ route: Int) -> SourceReferenceLayout? {
        guard var result = layouts[String(route)], !result.tiles.isEmpty else { return nil }
        // Use bright copies for screen 30's native dimming and reversible selection.
        if route == 30, let bright = layouts["29"], Set(bright.tiles.map(\.id)) == Set(result.tiles.map(\.id)) {
            result.tiles = result.tiles.map { tile in
                var copy = tile
                if let source = bright.tiles.first(where: { $0.id == tile.id }) { copy.asset = source.asset }
                return copy
            }
        }
        return result
    }
    static func selectedIDs(_ route: Int) -> Set<Int>? {
        guard let layout = layout(route), layout.tiles.contains(where: { $0.selected != nil }) else { return nil }
        return Set(layout.tiles.filter { $0.selected == true }.map(\.id))
    }
    static func photo(_ id: Int, route: Int) -> DemoPhoto? {
        guard let layout = layout(route), let tile = layout.tiles.first(where: { $0.id == id }) else { return nil }
        return photo(tile, layout: layout)
    }
    static func photo(_ tile: SourceReferenceTile, layout: SourceReferenceLayout) -> DemoPhoto {
        let fixture = DemoPhoto.all.first(where: { $0.id == tile.id }) ?? DemoPhoto.all[0]
        let imageRatio = tile.height / max(0.001, tile.width) / layout.aspectRatio
        return DemoPhoto(id: tile.id, asset: (tile.asset as NSString).deletingPathExtension, tags: fixture.tags, ratio: imageRatio)
    }
    static func bakedControlBounds(_ tile: SourceReferenceTile, route: Int) -> [CGFloat]? {
        if route == 30, let bright = layouts["29"]?.tiles.first(where: { $0.id == tile.id && $0.asset == tile.asset }) { return bright.controlBounds }
        return tile.controlBounds
    }
    static func bakedPeopleBounds(_ tile: SourceReferenceTile, route: Int) -> [CGFloat]? {
        if route == 30, let bright = layouts["29"]?.tiles.first(where: { $0.id == tile.id && $0.asset == tile.asset }) { return bright.peopleBadgeBounds }
        return tile.peopleBadgeBounds
    }
    static func recentAsset(_ index: Int, route: Int) -> String? {
        guard let assets = layouts[String(route)]?.recentAssets, assets.indices.contains(index) else { return nil }
        return assets[index]
    }
}

enum SourcePhotoBadge { case none, check, heart }

/// Individual reference photo crops in measured rectangles, with real native actions.
struct SourcePhotoGrid: View {
    let route: Int
    var filterIDs: Set<Int>? = nil
    var selection: Set<Int>? = nil
    var badge: SourcePhotoBadge = .none
    var showUnselectedBadges = false
    var dimUnselected = false
    var outlineSelection = false
    var photoOverrides: [Int: DemoPhoto]? = nil
    var requirePhotoOverrides = false
    var badgeAction: ((DemoPhoto) -> Void)? = nil
    var action: (DemoPhoto) -> Void
    var body: some View {
        if let layout = SourceReferenceCatalog.layout(route) {
            GeometryReader { geometry in
                ZStack(alignment: .topLeading) {
                    ForEach(Array(layout.tiles.enumerated()).filter { item in
                        if requirePhotoOverrides, let photoOverrides { return photoOverrides[item.element.id] != nil }
                        return filterIDs?.contains(item.element.id) ?? true
                    }, id: \.offset) { _, tile in
                        let photo = photoOverrides?[tile.id] ?? SourceReferenceCatalog.photo(tile, layout: layout)
                        let chosen = selection?.contains(photo.id) ?? (tile.selected == true)
                        let width = geometry.size.width * tile.width
                        let height = geometry.size.height * tile.height
                        ZStack(alignment: .topLeading) {
                            Button { action(photo) } label: {
                                AssetImage(name: photo.asset).scaledToFill().frame(width: width, height: height).clipped()
                                    .overlay { if dimUnselected && !chosen { Color.black.opacity(0.35) } }
                                    .clipShape(RoundedRectangle(cornerRadius: 9))
                            }.buttonStyle(.plain).accessibilityLabel("Photo \(photo.id), \(photo.tags)")
                                .accessibilityAddTraits(chosen ? .isSelected : [])
                            if outlineSelection {
                                if tile.selected == true && !chosen {
                                    RoundedRectangle(cornerRadius: min(width, height) * 0.28).stroke(Color.black, lineWidth: 6)
                                        .frame(width: width - 3, height: height - 3).position(x: width / 2, y: height / 2).allowsHitTesting(false)
                                }
                                if chosen {
                                    RoundedRectangle(cornerRadius: min(width, height) * 0.28).stroke(LoveliesTheme.pink, lineWidth: 3)
                                        .frame(width: width - 3, height: height - 3).position(x: width / 2, y: height / 2).allowsHitTesting(false)
                                }
                            }
                            if badge != .none, let bounds = SourceReferenceCatalog.bakedControlBounds(tile, route: route), bounds.count == 4 {
                                Color.black.frame(width: width * bounds[2] + 1, height: height * bounds[3] + 1)
                                    .position(x: width * (bounds[0] + bounds[2] / 2), y: height * (bounds[1] + bounds[3] / 2)).allowsHitTesting(false)
                            }
                            if badge != .none && (showUnselectedBadges || chosen || tile.selected == true) {
                                let size = tile.badgeSize.map { min(width, height) * $0 } ?? min(31, max(23, min(width, height) * 0.27))
                                let x = tile.badgeX.map { width * $0 } ?? (width - size / 2 - 5)
                                let y = tile.badgeY.map { height * $0 } ?? (size / 2 + 5)
                                let heart = tile.badgeKind.map { $0 == "heart" || $0 == "favorite" } ?? (badge == .heart)
                                if let badgeAction {
                                    Button { badgeAction(photo) } label: { SourceNativePhotoBadge(selected: chosen, heart: heart, outlined: tile.badgeOutlined == true, size: size) }
                                        .buttonStyle(.plain).position(x: x, y: y)
                                        .accessibilityLabel(heart ? (chosen ? "Remove from favorites" : "Add to favorites") : (chosen ? "Deselect photo" : "Select photo"))
                                } else {
                                    SourceNativePhotoBadge(selected: chosen, heart: heart, outlined: tile.badgeOutlined == true, size: size).position(x: x, y: y).allowsHitTesting(false)
                                }
                            }
                            if let baked = SourceReferenceCatalog.bakedPeopleBounds(tile, route: route), baked.count == 4 {
                                Color.black.frame(width: width * baked[2] + 1, height: height * baked[3] + 1)
                                    .position(x: width * (baked[0] + baked[2] / 2), y: height * (baked[1] + baked[3] / 2)).allowsHitTesting(false)
                            }
                            if tile.peopleBadge == true {
                                if let bounds = tile.peopleBadgeBounds, bounds.count == 4 {
                                    Image(systemName: "person.2.fill").font(.system(size: min(width * bounds[2], height * bounds[3]) * 0.68)).foregroundStyle(.white)
                                        .frame(width: width * bounds[2], height: height * bounds[3]).background(Color.black, in: Circle())
                                        .position(x: width * (bounds[0] + bounds[2] / 2), y: height * (bounds[1] + bounds[3] / 2)).allowsHitTesting(false)
                                } else {
                                    Image(systemName: "person.2.fill").font(.system(size: 15)).foregroundStyle(.white)
                                        .frame(width: 29, height: 29).background(Color.black, in: Circle())
                                        .position(x: width - 20, y: height - 20).allowsHitTesting(false)
                                }
                            }
                        }.frame(width: width, height: height)
                            .offset(x: geometry.size.width * tile.x, y: geometry.size.height * tile.y)
                    }
                }.frame(width: geometry.size.width, height: geometry.size.height)
            }.aspectRatio(layout.aspectRatio, contentMode: .fit)
        }
    }
}

private struct SourceNativePhotoBadge: View {
    var selected: Bool
    var heart: Bool
    var outlined = false
    var size: CGFloat
    var body: some View {
        ZStack {
            // Opaque backing covers a reference crop's baked selection marker.
            Circle().fill(Color.black)
            if selected {
                Circle().fill(LoveliesTheme.pink)
                Image(systemName: heart ? (outlined ? "heart" : "heart.fill") : "checkmark").font(.system(size: size * 0.47, weight: .semibold)).foregroundStyle(.black)
            } else {
                Circle().stroke(.white.opacity(0.85), lineWidth: 1.4)
                if heart { Image(systemName: "heart").font(.system(size: size * 0.47)).foregroundStyle(.white.opacity(0.85)) }
            }
        }.frame(width: size, height: size)
    }
}
