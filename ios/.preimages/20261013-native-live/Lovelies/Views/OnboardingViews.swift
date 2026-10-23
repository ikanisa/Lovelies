import SwiftUI

struct OnboardingViews: View {
    @EnvironmentObject private var store: DemoStore
    let screen: Screen
    @ViewBuilder var body: some View {
        switch screen {
        case .splash: splash
        case .introduction: introduction
        case .signIn: signIn
        case .photoAccessPrompt: accessPrompt
        case .photoAccessOptions: accessOptions
        case .faceEnrollment: enrollment
        case .faceQualityRetry: qualityRetry
        case .processing: processing
        default: setupComplete
        }
    }

    private var splash: some View {
        GeometryReader { geometry in
            ZStack {
                AssetImage(name: "splash").scaledToFill().frame(width: geometry.size.width, height: geometry.size.height).clipped().ignoresSafeArea()
                VStack(spacing: 20) {
                    Spacer()
                    Wordmark(width: geometry.size.width * 0.81)
                        .shadow(color: LoveliesTheme.pink.opacity(0.3), radius: 20)
                    Text("PHOTOS BRING\nPEOPLE CLOSER")
                        .font(.system(size: 14, weight: .medium)).tracking(4).lineSpacing(6).multilineTextAlignment(.center)
                        .foregroundStyle(.white.opacity(0.9))
                    Spacer().frame(height: geometry.size.height * 0.07)
                    Button { store.go(.introduction) } label: {
                        Image(systemName: "arrow.right").font(.system(size: 32, weight: .light)).foregroundStyle(.white)
                            .frame(width: 88, height: 88).background(LoveliesTheme.pink, in: Circle())
                            .shadow(color: LoveliesTheme.pink.opacity(0.3), radius: 25)
                    }.accessibilityLabel("Get started")
                    Spacer().frame(height: geometry.size.height * 0.06)
                }.frame(maxWidth: .infinity)
            }
        }
    }

    private var introduction: some View {
        GeometryReader { geometry in
            VStack(spacing: 17) {
                AssetImage(name: "intro-collage").scaledToFit().frame(width: geometry.size.width * 0.961)
                    .frame(height: max(230, geometry.size.height * 0.46)).accessibilityHidden(true)
                Text("Your photos\nfind their people").font(.system(size: 23, weight: .semibold)).multilineTextAlignment(.center).lineSpacing(2)
                HStack(alignment: .top, spacing: 15) {
                    introItem(icon: "person.crop.circle.badge.checkmark", lines: "We match\nyour photos")
                    introItem(icon: "person.2", lines: "To the\nright people")
                    introItem(icon: "square.and.arrow.up", lines: "You choose\nwhat to share")
                }.padding(.horizontal, 15)
                Spacer(minLength: 5)
                PinkButton(title: "Get Started") { store.go(.signIn) }.padding(.horizontal, 22)
                HStack(spacing: 9) {
                    ForEach(0..<3) { index in
                        Button { if index > 0 { store.go(.signIn) } } label: {
                            Circle().fill(index == 0 ? Color.white : .white.opacity(0.3)).frame(width: 8, height: 8)
                        }.accessibilityLabel("Introduction page \(index + 1)")
                    }
                }.padding(.bottom, 10)
            }.foregroundStyle(.white)
        }
    }

    private func introItem(icon: String, lines: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 28, weight: .light)).frame(width: 64, height: 64)
                .overlay(Circle().stroke(LoveliesTheme.pink, lineWidth: 1.4)).shadow(color: LoveliesTheme.pink.opacity(0.5), radius: 9)
            Text(lines).font(.system(size: 13, weight: .medium)).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity)
    }

    private var signIn: some View {
        GeometryReader { geometry in
            ZStack {
                GlowBackground()
                VStack(spacing: 18) {
                    Spacer().frame(height: geometry.size.height * 0.08)
                    Wordmark(width: geometry.size.width * 0.65).padding(.bottom, 10)
                    Text("Welcome").font(.system(size: 27, weight: .medium))
                    Text("Same photos.\nMore people in them.").font(.system(size: 18)).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                    Spacer().frame(height: 8)
                    Button { store.go(.photoAccessPrompt) } label: {
                        Label("Continue with Apple", systemImage: "apple.logo").font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.black).frame(maxWidth: .infinity).frame(height: 48).background(.white, in: Capsule())
                    }.buttonStyle(.plain)
                    Button { store.go(.photoAccessPrompt) } label: {
                        HStack(spacing: 11) {
                            Text("G").font(.system(size: 25, weight: .bold)).foregroundStyle(.blue)
                            Text("Continue with Google").font(.system(size: 16, weight: .medium))
                        }.frame(maxWidth: .infinity).frame(height: 48).background(LoveliesTheme.surface, in: Capsule()).overlay(Capsule().stroke(.white.opacity(0.28), lineWidth: 1))
                    }.buttonStyle(.plain)
                    PinkButton(title: "Create Account") { store.go(.photoAccessPrompt) }
                    Button { store.go(.photoAccessPrompt) } label: { Text("Sign In").font(.system(size: 14)).underline().foregroundStyle(LoveliesTheme.pink.opacity(0.85)).padding(15) }
                    Spacer(minLength: 10)
                }.padding(.horizontal, 22).foregroundStyle(.white)
            }
        }
    }

    private var accessPrompt: some View {
        GeometryReader { geometry in
            ZStack {
                ScrollView { MasonryPhotos(columns: 3) { _ in }.padding(8) }.allowsHitTesting(false).blur(radius: 1)
                Color.black.opacity(0.5).ignoresSafeArea()
                VStack(spacing: 14) {
                    PhotoHeart(size: 76)
                    Text("“Lovelies” Would Like\nto Access Your Photos")
                        .font(.system(size: 18, weight: .semibold)).multilineTextAlignment(.center)
                    Text("We'll match your photos to people\nusing on-device processing.")
                        .font(.system(size: 14)).multilineTextAlignment(.center).foregroundStyle(.black.opacity(0.8))
                    VStack(spacing: 8) {
                        permissionButton("Allow Full Access", strong: true) { store.access = .all; store.go(.photoAccessOptions) }
                        permissionButton("Allow Limited Access", strong: false) { store.access = .limited; store.go(.photoAccessOptions) }
                        Button("Not Now") { store.access = .limited; store.go(.photoAccessOptions) }.font(.system(size: 14)).padding(6)
                    }
                }.foregroundStyle(.black).padding(18).frame(width: min(340, geometry.size.width - 54))
                    .background(Color(white: 0.92), in: RoundedRectangle(cornerRadius: 19))
                    .shadow(color: .black.opacity(0.4), radius: 20)
            }
        }
    }

    private func permissionButton(_ title: String, strong: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).font(.system(size: 15, weight: strong ? .semibold : .regular)).frame(maxWidth: .infinity).padding(.vertical, 12).background(LoveliesTheme.pink.opacity(strong ? 0.9 : 0.32), in: Capsule()) }
    }

    private var accessOptions: some View {
        VStack(spacing: 15) {
            PageHeader(title: "", trailing: false)
            Spacer(minLength: 5)
            Text("Choose Photo Access").font(.system(size: 21, weight: .semibold)).padding(.bottom, 8)
            ForEach(AccessMode.allCases, id: \.self) { mode in accessCard(mode) }
            Spacer(minLength: 5)
            PinkButton(title: "Continue") { store.captures = 0; store.go(.faceEnrollment) }.padding(.bottom, 16)
        }.padding(.horizontal, 20).foregroundStyle(.white)
    }

    private func accessCard(_ mode: AccessMode) -> some View {
        let selected = store.access == mode
        let icon = mode == .all ? "photo" : mode == .albums ? "rectangle.stack" : "lock.rectangle"
        let detail = mode == .all ? "Get the best matches\nacross your entire library" : mode == .albums ? "Choose specific albums" : "Start with a few photos\n(you can change this anytime)"
        return Button { store.access = mode } label: {
            HStack(spacing: 16) {
                CheckBadge(selected: selected, size: 30)
                Image(systemName: icon).font(.system(size: 25, weight: .light)).frame(width: 31)
                VStack(alignment: .leading, spacing: 5) {
                    Text(mode.rawValue).font(.system(size: 17, weight: .medium))
                    Text(detail).font(.system(size: 13)).foregroundStyle(LoveliesTheme.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(17).frame(minHeight: 111).background(LoveliesTheme.surface, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(selected ? LoveliesTheme.pink : LoveliesTheme.stroke, lineWidth: selected ? 1.6 : 1))
                .shadow(color: selected ? LoveliesTheme.pink.opacity(0.13) : .clear, radius: 15)
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var enrollment: some View {
        GeometryReader { geometry in
            VStack(spacing: 15) {
                AssetImage(name: "portrait").scaledToFill()
                    .frame(width: geometry.size.width - 22, height: max(310, geometry.size.height * 0.73)).clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 19))
                    .accessibilityLabel("Sample selfie preview, simulated capture")
                Button { store.capture() } label: {
                    Circle().fill(.white).frame(width: 52, height: 52).padding(5).overlay(Circle().stroke(.white, lineWidth: 2))
                }.accessibilityLabel("Capture sample selfie \(store.captures + 1) of 3")
                Text(store.captures == 0 ? "Position your face\nin the frame" : store.captures == 1 ? "Turn slightly to your left\n2 of 3 sample selfies" : "Turn slightly to your right\n3 of 3 sample selfies")
                    .font(.system(size: 14)).multilineTextAlignment(.center).foregroundStyle(LoveliesTheme.secondary)
                Spacer(minLength: 0)
            }.frame(maxWidth: .infinity)
                .overlay(alignment: .topLeading) {
                    Button { store.back() } label: { Image(systemName: "chevron.left").font(.system(size: 19)).padding(12).background(.black.opacity(0.3), in: Circle()) }.padding(16).accessibilityLabel("Back")
                }
        }
    }

    private var qualityRetry: some View {
        GeometryReader { geometry in
            VStack(spacing: 18) {
                PageHeader(title: "", close: true, trailing: false)
                AssetImage(name: "retry-portrait").scaledToFill().frame(width: geometry.size.width - 70, height: geometry.size.height * 0.4).clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 24))
                    .overlay(alignment: .bottom) {
                        Text("!").font(.system(size: 36, weight: .medium)).foregroundStyle(LoveliesTheme.pink)
                            .frame(width: 59, height: 59).background(LoveliesTheme.canvas, in: Circle()).overlay(Circle().stroke(LoveliesTheme.pink, lineWidth: 3)).offset(y: 24)
                    }.padding(.bottom, 23)
                Text("Let's try that again").font(.system(size: 23, weight: .medium))
                Text("Make sure your face is well lit,\nin focus, and centered.").font(.system(size: 16)).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                Spacer(minLength: 5)
                PinkButton(title: "Retake") { store.go(.faceEnrollment) }
                QuietButton(title: "Use This Anyway") { store.capture(); if store.captures < 3 { store.go(.faceEnrollment) } }
            }.padding(.horizontal, 22).padding(.bottom, 14).foregroundStyle(.white)
        }
    }

    private var processing: some View {
        GeometryReader { geometry in
            VStack(spacing: 17) {
                Spacer().frame(height: geometry.size.height * 0.17)
                AssetImage(name: "processing-hero").scaledToFit().frame(width: geometry.size.width * 0.675).accessibilityHidden(true)
                Spacer().frame(height: 15)
                Text("Finding your photos...").font(.system(size: 23, weight: .medium)).accessibilityValue("\(Int(store.progress * 100)) percent")
                Text("This won't take long").font(.system(size: 16)).foregroundStyle(LoveliesTheme.secondary)
                Spacer()
            }.frame(maxWidth: .infinity).foregroundStyle(.white)
                .contentShape(Rectangle()).onLongPressGesture { store.showGallery = true }
        }
    }

    private var setupComplete: some View {
        GeometryReader { geometry in
            VStack(spacing: 18) {
                Spacer().frame(height: geometry.size.height * 0.15)
                AssetImage(name: "setup-hero").scaledToFit().frame(width: geometry.size.width * 0.733).accessibilityHidden(true)
                Spacer().frame(height: 28)
                Text("You're all set!").font(.system(size: 25, weight: .medium))
                Text("We've matched your photos\nto the people in them.").font(.system(size: 17)).foregroundStyle(LoveliesTheme.secondary).multilineTextAlignment(.center)
                Spacer(minLength: 15)
                PinkButton(title: "Let's Go") { store.history = []; store.go(.home, replace: true) }.padding(.bottom, 28)
            }.padding(.horizontal, 23).frame(maxWidth: .infinity).foregroundStyle(.white)
        }
    }
}

private struct IntroCollage: View {
    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            ZStack {
                AssetImage(name: "photo01").scaledToFill().frame(width: width * 0.28, height: width * 0.36).clipped()
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.8), lineWidth: 2)).clipShape(RoundedRectangle(cornerRadius: 8))
                    .rotationEffect(.degrees(-13)).position(x: width * 0.27, y: geometry.size.height * 0.39)
                AssetImage(name: "photo17").scaledToFill().frame(width: width * 0.23, height: width * 0.23).clipped().clipShape(RoundedRectangle(cornerRadius: 9))
                    .rotationEffect(.degrees(4)).position(x: width * 0.57, y: geometry.size.height * 0.23)
                AssetImage(name: "photo04").scaledToFill().frame(width: width * 0.25, height: width * 0.26).clipped()
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.8), lineWidth: 2)).clipShape(RoundedRectangle(cornerRadius: 8))
                    .rotationEffect(.degrees(12)).position(x: width * 0.79, y: geometry.size.height * 0.27)
                AssetImage(name: "photo05").scaledToFill().frame(width: width * 0.24, height: width * 0.28).clipped().clipShape(RoundedRectangle(cornerRadius: 8))
                    .rotationEffect(.degrees(13)).position(x: width * 0.81, y: geometry.size.height * 0.77)
                PhotoHeart(size: width * 0.4).position(x: width * 0.5, y: geometry.size.height * 0.65)
                Avatar(asset: "person05", size: width * 0.16, pink: true).position(x: width * 0.08, y: geometry.size.height * 0.44)
                Avatar(asset: "person03", size: width * 0.16, pink: true).position(x: width * 0.91, y: geometry.size.height * 0.52)
                Avatar(asset: "person01", size: width * 0.17).position(x: width * 0.15, y: geometry.size.height * 0.86)
            }
        }
    }
}
