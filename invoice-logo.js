/* ================================================================
   The D&L mark, as the image stream it is written into the PDF.

   This is the EXACT stream out of the approved sample invoice: a 370x220
   DeviceRGB image, ASCII85 over Flate, lifted byte for byte.
   images/logo-1@2x.png is the same artwork, but re-encoding it at run time
   would mean decoding a PNG, resampling it through a canvas and deflating it
   in the browser -- three steps whose output depends on the browser, so two
   dispatchers could produce invoices whose logos differ. Reusing the stream
   makes the mark identical to the sample and the document deterministic: the
   same invoice built twice is the same bytes.

   ASCII85 rather than base64 because that is the form the PDF itself wants:
   it goes into the file as written here, with no decoding step anywhere, and
   it keeps the whole PDF writable as text. Backslashes and apostrophes are
   escaped for JavaScript and for nothing else.

   Regenerate only from a newly approved sample, never by re-encoding the PNG.
   scripts/invoice-pdf-matches-sample.test.mjs checks this still decodes to a
   370x220 image.
   ================================================================ */
export const LOGO_WIDTH = 370;
export const LOGO_HEIGHT = 220;
export const LOGO_A85 = [
  'Gb"/,0oR-nO]?S``JbW_BC&0>ia!Bcq[4r?!D4sU5_\'EALl!)WMK\\q#I]k1@cDMm8aT1d?kjAEaTU,lh-3tS9Rd2a4-U\'.J"p',
  '0g92Z*5pH8PWhSseKl<RoP]>7Um(U;$X)m]!@lH<jOafdIOAKgMJ0-km#B6D74(\'FKO\\Thm-O$ACg?:ad"bKgMJ0-km#B6D74(',
  '\'FG!_<Y(f#rBL3PV0ogoj6f]lp7%,WIeriOQP,bVrYLVC+6014]\\I;3m_AYPUL-7]o;gJ-8A*iMq!$+Sqo8:j.Wrj[T7?b/s-R',
  'p>->W0lWBfqs?s@k_DGEGQ@3d4m7[4+mf(T$\\pKX/;YJQ;[q4L\\JJa:DME\\lbJm!SBW;b7`A(+tXOS)`SI;/l^[.EfoZ$j>gY',
  ':Rqh]hRW6672)m]:-KF.?WI]/Z+StaGjFC.-D*43U-*i&JuAki(Df]DPUV+VmQWJH\\JYD1=[VEk#i/d;hG-6APp,+,8+Su5l$:@',
  '8)gC7WW$]_gn:\'\':qrFEDoK7fp,es*L\\!)k>AOJ"?@Sp$7*WiB/UfOYS\\j-!=<(>rDYFek3Y%X]TSE0>/4BW>jY-:Q_%mabp',
  'i(VQZq$bVHH8Yho5`**;IItS%LS-CT[9/\\)^Nq[2>cFq5iYRJ!]Q<8`j?l`]QRX2PMi.rh<G!Jo$qqsIaqmG]jW=S=dDqc1;Mh9',
  '>:qkikQ1(YfPZ4\'5&<E)X&"ZKZ"I4!&aj5FR\\G#$WR4>NT7\'`$k\\9C/9;PeKO4(;IlEmRX/2F=C0LH/7,-so/doLHp/0*KNq',
  'R$1?;Q,hdq<)"cGC*?S65@HH:<&rK^nqEGhO:@YN0H5<\'j)6?7TVP3U;G0M>C+-c#^Ti99WFbOsQ,Uni`cN\\#a],g\\\\9RUt0',
  '-_N^Gk/kjg5ItC*)&An77e4\'CoR4:LF6/AhSUCYR0CkWjJP6B/aTg39\\:5MQeGCkY,;V#8ool\\9dX5m,m^ak,9*TW$&d>(?U(',
  '*-&>]B]rT!?Q@S0@hZJB%IWZ2Ec7HG^M!@Hpt`82@%nG*H+3B]G_R1IP0-XYKS$8KEB"tHUX=B/5[PSl/.E#VJ9!N.6q=s,.^7GQ',
  'P$=C&IW2eRUN@oXjrs,)shG&V2F_Vn(/>r6U(SqD#d&.iDM3F_e["KA\\VS2n:31ssQ*N?q44U^AtD@Bh"gEm>_Cfk-Ou2H-I[>d',
  ')*rB6kqSRpi?EV85fdbEAj1G>uaGf7[hl@0nRo,,l2p@nX^Xj@o#!KF]%;,ulE<<Clolc(7p(o\'k]oem"ML+f\\cMWNocAhD>]7',
  '[s\'\\)U7PVifYLq.rZNmYThi:RmL>d+g8UBsK.&ig>c,YaN=Rg?c8[RQ>qJq^WBqNc@Wh(hI3hkp@Ck#_nr4?K4$>ZdT[s\\)3U',
  '`^t>)M8.dYC&pgt"d9<7sL=laER&@63&nA5jG3bL][(\\^!pLW2!6d:R-`4g(u<%jgp>uo0ORGOF^J)q/(+39*adQ@B\\),97Qg0',
  '7O@f;,B=s`drDUHcV1kjij(lB,j<.LSg=??3-st"IJ)a9D#&!oOI7pW!igoQH2.:@Bp_Pg>tV,M6e&+I1K>Wj[9+%>U*pj1eO9?_',
  'D4lcU$7#*TH=aY4WEh<qo,$9l=VW-A(ItLl*T?UKdkVDSRuE(dojk(a8<rM\\\'38!W$?EdO^.ae=6Rc[$QV#\\.Wj\\)]+)Gei9',
  'U4qS.D$J5,f7Y_o9A=7QFI3J<YP1=bC@^!P?`f@;8>i<VrR7lF33\\U^mhM/\\*)JIqs[MABi*%Nl.L@#F8(]8]&L^>+)%MY[2\'',
  'u+PZ5a8QJuJ#R.*dW7\\F?E<-au\\llG1Mh_]LY\'D9I]"5,pc<VDKS#kZ7?SZ9[/^3]:-rQm.U)Vi>LaHlj\\OXd>>V2D\\3L9&',
  'G6bYHj9!%-bP<#6b2O^KsV_d:$%0D&o</LkQu1FT5#$)p8;<"U]RJ?$qVZ(X/KLjF_d4-!WOX>2&\\j42oBcB\'O0VWmptR/KZDW',
  'Z2kVJn=N3=&2rZr@]49%AiTu:abU.&Gr*0Ss&fb&9Q8n>jKV3DS\'pn<LbBmV95/@]R!nhNPm"8#Q,k"3ijQ9LGf"/-W;<8PTH!b',
  '#fsZ#U1!kIq\\*d;0N7aHcratGos%5`;L9"q[*kIj&D<#NGC<Ba,KeM)dq_\\Ib;cunmD&T++rsckln#C"p,oDCbb3o*XVN-#YR=',
  '-G#sr9\\m+j;=I36gN.+7A5\\aSRDd\\jIO5U!]hD9JfP+!BaF;!GC?[t!o-gMbdai6cfHn4YN$T;s\\8"Bt[IX8n3PAu`e,eYU:',
  'OJ2O[!`8:8C&hUO>-7(Xeb;Gha0GVDqgFi283JrYcYD(5-qt:u+2t63QC_;4Z.a>e:\'c`tT=#3N@VbW!p=;p"u\'GsFZdoT*:dr',
  'J0)6!ItcC$-4J?UL[AL;Z-LGkLsSfLN+#\\o6Ii4OW^a;S+#QWJ+<F?@Efe<)\'V[<WmRc=HWdk]-UISI]#ZVBB\\^hBp)I.9iRe',
  'J/.K;kjrE0>,d8O#>A[S4TN7nP9GQjSV]e[?>XP87B4:1-(M/[XoOM[r&g[9YYXMCn%56>)Sa@,=\'&P77$-bo)7&M\'?/_LW[9W',
  'I;`7(oL.V_n8YEH?o\\Q]h?dd7_Ef"A&_n\'WGPC@NZ177FsJX]]a\'MD>/Yqinm<r8X3>F"?GI%X<CS9E)a!0Z595C9\'Hj.A^E',
  'i^R93n_Na@U@3jhparmU"=M,"4EeR9ok:C$"bSClDr4_I@W]>@][L;"ESZ<5N=jn?@!"9k/rEd#JqL,c/Qh5j$(<4)B`QP\'5D;r',
  'nIfP"IfkcQr0i-Pg.%d*R$;)ZDQk"f[Y0;s!M%fZK&6L<;&o7m*S>W`=l_^.<HEZ3XCrTcmDC3W>LIjGL]s+\\o$WXQ`klD53]%h',
  'l0=E-^#st<b>4\\UUTD5\'@%Fb\\mWgQmL,@b8/:YgQ,P4f+nQs=%@((^le$hq+,3`</<JLQb#$q`Rk]6.8pgJ;Ju:Z;e<6dT4r&',
  'E7oWYok)g+.NZOEg"(e\\[1Oh2CHRk]6.9&#&3o!_tV<)NXY+]AQV%$=L<W)4)G@?tmSBOcnTYf,AF+ZVYnl)e.3n__h?>5uQt\\',
  '193GUhT)2YdkRes"C@,=`&"8D(MsG-,+R3^O<[*f\'Wd6<\'dO#Ch+\\M\'miGm;MB.#_CUHi`8cfb5a)%<U>2#qNfgPgQtLXIG[',
  'FKf^F\\+uagOs%BKQ%MgSZE#\'Qj73[8]Gl[#p\'t4>c.a6rJ`%L<;%eLKWc<QYG36Z>VfTO[D[t\\4EX!-`-D7VY`Y&L$DT0\'f',
  'U!K?$Vh\\Mq+(3GDVf9H_YHba3#BW=_;(h=\\.;#`&>)X^fEs"m*8p240RLs5,<)E"mJ-7El$8LKRQUV#NA/r*.=!0kpn%W+Wk=(',
  'C!8<G$5PB`O0ln=%`T0GG1Ie\'2AD;&78MFR3\\k-1=r$"n3a?>i0[Zk%Y3D9KQ*OCIc4\\M.NHOC@qY2"!Vg"pn@qQZqFC%n0/k',
  '@?i=pIWug.KM;:=%5)8X4fHE#c";?:O]W5Kkl1DS^c<jd+sN%!ea4%i=4X8A3k,lI/J%TnE\'"PuN#r8JN`qXc3ag;TM$j50RcNq',
  '_5cXk^l[\\9tKe54#tjT[ZaG["8WN\\kkK\'oW?kJ3S5`Xol.n4RBrGjbEL7K4bK$n0LYsQLmsJA4=\\$s;O8)YY,oKUWODSQ,WI',
  'e*kd<U@LKt$#36feo?_V9%`R2@iB_b]4JBe>*&S3^l#+4*MD]InA&;@BHJ4r&tjYn7+4?gNW+gfWe>K-=4rr%:i:A`GZ4$L,uN\\',
  'e%8(fAR%K1A[]0G!E3_afM57ME%T@>gr.mD0OMC[OQ<p8t4WT?m3EZ>.d8uE\\Im*&lEQ*Fom.aQ<HWM6P"X&f>Z$,=Sd)NJ2jO6',
  'InYn+gR>FiXU9hJDh<eL"VR2]lHlG+mA@JurX`"r;Y&$Dr+btY:9#F:g3ZgfVh1ZD`,&F":pjR&F9IOKn3Oau7T""r@\'Qs=mQ=N',
  '@ltK/-/8<S@Paq[=(Ec_>.cON92X)O+8?ec1:Ce;RR0?p.(Do.(-I52M5(#-HUbX5oDHbE68JT6sWN([/80e_?agYAd\\4q^DP(e',
  '!B+T(bt$:?l[jRNI<BIJ4\\\\#)%Q)Ya2?Q@aPPIUE?N5bH7/&8sSMd4a48.W9elq)^H#p?,ZC0Yg!Z5%o`f]6a&iA$/d?miCt18',
  'Xk`>.3YU8C8mr*9&^$h/ks2"rLT$0OXd4\\0>R#`9SjY52<\'M0\',s)So_%$RpOb&kGA#/#nLg[Y$"F-U<?0i=!\\Is@K>qu\\?',
  'uY>-OQhaKR\'%khV51HuTjN,/!R^T,Z*IW`,JcBGIMtsC#9MmkA5MN-ZI8X*Ef_d<$("g1VEH+*`(:](!g$<k+#fOY\')hXq9D8K',
  'd@Wp0?PhPErk+/mDC78pPpB*mY0;T(jpJ\'&7+Q#K?DH18$5P2#9N.h[23tH.rf6/n&okeEH!+/JnO(>i!OE+XnbX>#;,>A1ESQ)',
  'lYXHUCtqI*Dt3sS/pJLN=)Kmj?r$3D;a`q=ASh%(?V^6J1R4B&(J(aDM%/cS\'.4(Yu#1n8_!Co@u6QA-e7lA-=m1F7h-&WYFl`9',
  'Umq,ZU*/O@&(p=fgi=?O!C$MTZ%<+_`q\'*#Q#8\\.].fA$]3\\SCf,Fpt_%8Mk-\']6E5jNP[(<RUe3)lO.3FjiauWIc<8>?`^p',
  'p3DTVKgIOaaPZZJD[V,(.nU83YY%^N8)VH\\YU6GE@SS9>Af<JK41j"Fh:TS18%g3;sI_H11FnL)28\\3%Yh\\fYb2l-hMtYjgKe',
  '0Re!DKBsV`[?N4nW[5-=Ch`\'_B*J!.JXOANJlC\'&-AZlWHLQkjrU<gC5otOM\'$lH96KLbfB=TX<*[9FQM[SNGGjc[CO=GTIm2',
  '=9(dU\\p_rHZ;^L2FPs/L?Smd/gkI0t-KT2HPA46<Hr^oMcDM<>n)oW)mj1A*^0hXUk&?Y&N+*9OB`1gZM,ofiW-i+j&mjPQb%jW',
  'KL@7(+tL[]qm"RGPob."Zn&ZRCCCTJ5r:E01qmS)BAPG3NCRfc/(Ai_<`&S/%%XJQ;!R^WqI:1;FS]N2MA!!QYBGD\\G\\dL`1He',
  '@m,P(#=\\>^$H?HGm^"S2a-%`a(\'t>teE;L(L<CO[.S=lZ`$/I>V$bZ!8D`5k?<,uJY2FOC4(DoP1UtR`&b1+28/@=qW.UcO.Hg',
  '`)pjeqa(YrSLpX;("$QfdhX<M;$G<?,-%KS^dL9hI"5$8l[@V_$H"=5+#LIaACKRrZ_n"Lm8.R2+q$9a_V!VM7>-9"GER2;nkuX]',
  '2L4O`ot1-/Ultn6/\'QqWUbON?D4\\Wmp2:Zf4l^g@/n?-:IJP\\ZsRZ[Am<_0UWu]8qkUu^*TlQl.L?+9PFYL">M:]VP)iZ:gJE',
  'uDSP*."\'"C@o,"Vn&\\7a3h%/Y$QGuVk<N70A`%tC3]jbgF?9?kU*Em2h-ho0mES(:cZ7YcAraFWJL!KF"\\T-5es.oS0`N"g/2',
  '(\'eP-af3=LhEaS*E@(jQ49\'HKq1QP?5C(WNa/DE5>\\pddI4EbJA?nmklQLMJ#oHg2WUlUM0B"jeF`qOa0d6M_dBH>P,>UDSgr',
  '`q$<+"Rftd@bjN=bO+_EB+)bBh"$.U(0NrQPaM@E`O;e>urV5qTu+FQ6gV;SW76[=.o8,%Y(+mo\'N8hCu=s7YNp@\\okm#GY.Zc',
  '!ea=<LV>rHM<%PU"raIj52=]e&4hC7^&&XZY4,R`VPr6>7L(c.SZYOT)ENDo]`q.FJ3l]<3\\`uA[?DXAZ93G$VWE(73P\'V,?6_',
  '+.@_93a+%**d/;X^B2t0qflTpjKY+?a(lYt:.3[+rIoB7aJ]ZnB<J+I5BQ6p=ou`_@"?s\\>iSejLSt.8/8:FI5EDs8;I2`t=(R1',
  'DJWn<t53.F`3/i-Xc2.c,4m"p*cG[a6(^Xp&%C\\Io9Xm&To+HPCN3<M$AIYutHEftRl+&`C#oK\\U%n_"[%K>E&Lgi?[h^/e"As',
  '2AJ?VM^Nd7P7hF%Ccb$6*R&i/(@l.+E(&W:bl$Yq\'2?)"C%-@<^BJW;O\'(;V3U18AZRYSkdei_T7:W0hn_hqK=$&?pQ+oQ"&32',
  'Xpq>6Om%t8d/Ld5PWPZD5okBb\\`YlsNpTGJ5P>6q0MXep$h`J1Q-?n<n9"5ur0Uk%q;WI]olFo]e;cP.W@\\h+AWa\'K>lDsh_B',
  'T.?SiM9$cT6`)fE!`B#/?T)WaqR/n7F-^E#3dVV93J\'J$Fa!^;h[Gu;Iqm4p=WBJ[="s*<71)I:/W:8U;AB[O=ChOdT)/@8u>4-',
  'gc>$=<(<[LnfK/XAg>6`7b)9+?Sk\\M-*pjgFhb$K*u/[mU-;YkVi")9+d+>7f.3e]V2G+Sc$u4H:e6jGL8k[tRaa[(S=Z:PY;-W',
  '^h__@I9&WZ@1Hj!ZS;kl7Qmf.9\\5Ybo=QgXL4G;R)6Gqd!V2@q]$VdOhLX7]EdK@=Kjm(*;<KJ[GR^#\'ZTp$rA]#>@6[?)jY`3',
  '1^k&JeiQ8r$KOIsCR;0..j%MD#^,.NS.\\Z"d^[E(\\fK!X6;O\'q$N]YXrP?=hV\\!MtaEIr)rV#MNTJKmT/&9\'/$Xm)V-;L=7',
  ')NLSKk/\'HtY!1W[Rlb!RqG\'ORfjqM9mj2fGkLH^\\P^4lF0G>23KFQT"k%A:A\'BL4aHe.8+551.9E_Wn:j.;lkLemC3tTKjQ!',
  'qD;T1d>$ACg?:ad"bKgMJ0-km#B6D74(\'FKO\\Thm-O$ACg?:ad"bKgMJ0-km#B6D74(\'FKO\\Thm-O$ACg?:ad"bKgMJ0-km#',
  'B6D74(\'FKO\\Thm-O$ACg?:aidBqXs00^\\cj%s2TWK:IcHhqCc3)s80i;rplEU9n)<F`Po/JquQ@QJ,5?^ph%UJ=0EHr3KD^@M',
  'ep^>-tWc:mG$r6,RDAhr:e[<42:f^G<U___p;g4CbK0c56$t]s7E@AL=h9ukXdl?hn1PFT=pkM3Sh.2p`sFNLOej3>JN.*Igl;Ws',
  '!hI!1%9(Mn<)U_j,*KW&oUo]!KB]*.JNl8h^B#SruV.j-p6*hHf<0KEG.`/%4V4ghG</")%CiZ0>SK65C4tBAt+"Tg$-I7pBiH3I',
  'LM15W,%8&_1q!:i)t6l^n97O7Vk-if)Hh4nf`5]Gc-MlN,S%Tr2i-V"g]cs%cD,L[;2[J>&lf+c==]G3mWCA83FsPUqKe4Rc]!\\',
  'dE5n%+ncmkNU)F\'?\\.Ya+/:77&8\\EW"#BF\\p,=&VMSl_/m4;,M(l&;TAB_.]mFTJ=&&l\\FbderbrkkUOYtIc5Y9E:]ODj6j',
  '/1S@]gmE.7n5okSou\\uUJR1(++l,PtiqP4TBn9\'C[YcC/ZqW@DekPF7-E+NIBUI9:^NL;Aje9ti_p!:q+eIQf7dq:P.(E@A-$I',
  'L=6eZ<USF?c,J;&9)<BRDjO\'5o\'WuG4OB-=rT_jZHgh*dN\\YE`KnK[s*U*34\\c_Y\\"rcCHDl0!"R]r![aP%q!tiFV<)&n)E',
  'mYDr6gk=_5>IF1^*LD1I[;pc],cL)tI6i=AD5k?@+mg::NHL-.jD%68605,qD:m1bGi&ftOD_@h6M!(1fC>)&-F=*o@FL>B$/?C;',
  'OO[r?$Pnh#Sapu>R..&$7?^)=t(k^0f=Y.)0p18rKUJGRZq=YJ)$NP[C:kmr61^S,VW8^=+$YBV[kBP#8>-ehN-a#RAr++_8^^[F',
  'iW,[9DcY?gKfbaJ&G_F0EhZl!!2/:4aV+Wea,A&ls$KKjoVjhFaOD.E)RSAR4sHN,eHORX4bF*j[,k;0iPF1I"MMY<eas"do"Xp)',
  'OsI;bjq<s)b>_;C/t,>)=bfj1JKG[DZE)WKp#2>/%Z\\t8feEUS,J\'2CLH5!e#jE]Z`dijlbFj/X@s6kDnIM7V[ZHW)[TXCZmo]',
  'oIY>/b6JH,Le$O+W]P0S/(,b.f\'q@.s^\'+djaUu:tOCAki>4kOF:Ji*qB&gf-IN/">uMSM0X7U39LdLc-$qcYMSD0$,,6@.!Oi',
  ':b9&TiM[@m>=9\'^)/^L2?pP`u\\",AGdQ3YiI^&uJJSB>CiU`i,#ZSU[toXRZ.#pdeOa-U]`)0Wn]P(0mAn.MW`JMG5X.uCqArR',
  '&nuHf)6k,LNu]n.8f5>mH*K^1YNsI7rp$aUkkP(4gNJkW,QW=_K^%Hi%`+K>-1eh/04@/L$%E08&jVKYT:[fuWB31f26jR?9IR)B',
  '+Xkp+;MsO:5h4$llH-\\)Y+tRfk-P9?0sI[adqnkR4RV@Ris+ikK9\'b([#Js5ut,5J?rGkk6Sobu#T<ceA_nF0\'@O.sV"OB?mX',
  '%3<V+t>NecqENG$<SWGGj[;#D/BpUe5e9-^Vn%!N+F$nN$G[MAB^sGI@J4>cbN(&Kja.LTCJkB5ri$Tj+*rS\'6]R--.pVQ\\n?c',
  'el2Ue^H5!pu[D)9`1p>:p43jJ5S\'VtJNUHP`b*-*a!>K^9)\\]k(G^),aS30V/A<LHjYMIp5Y#X8KX\'36iAQ\\*5kdN!&g>*7e',
  'VH*]g\\F$FIiV*SX.TJn`mUL1#,i6OqH9OZ:m6p4ZgGjjtgK*f*AMA&L\\pOYsSSbtfc9_?hqX8&b1;o)G;AhMoGC]t;<FG*VUA/',
  '#;Tl[nB_>FrA$O2VGE)QCib"2f=22Jl)7&(eLdD>tqIreG#5uf;\'2trWpd?2PM*WiPY$-\\MN38(Z^OGnO3k\'*0+%hl!fr)[Z-',
  'AX2b"_1IiRfu-bXsXMc8p)=EsVY;FDC&*.<1,DLqr&5.S?U!>>":NSa/;80iR@BD:1n"o\\J>[CCT1\\)6PbHJ;+kkVmUf:Dp?PA',
  'Qd_3m=V4,)\\W,UFi91)+bM4Q%m25`,3VJpn-9kLqm?,^N5Y7>1VdkJfQe9<@inThB1&qQZEju$[M[Y_?:qkW.J-,h1HCKRQZ0pS',
  'JWrK/DI+m2gRDTlljZ\'/Uf1Bji.jP`4c>&<m7j3.YfArfG/Nk!\\2a(\'-$QF"B&;tu/%rp;DF:[W^P*t>C8e[r,Bu7fUY7t*6)',
  '#T)Gkf0OUhp\'cU;A#PoS;%&(sg-^89*F>^P\\TNGI3Kj:`;*bropjII!X(-+FNm8Y(s`HL&kI=`O;@m$,t,mGOc9jp6!EXm4HPh',
  'aV\'VW8Mo,)O?URA6?n>u1<.3pBrg6p*SYrYYFtdA)*WtN2PT7oBnpN8Y7`^+]r*R?l-Dd#Q63m5\\\\2cNW9eDtLJ5d/1CHPGfO',
  'TUVB!UUoNe_tU<[FH\'57:OTY2nVk>dLj$P1\\S[6=!Fk;@4%.XlJZ@Nd;(9\'jo;MIJU9+AQRB],i!IZo$YRDI)N&+h\':j1]g-',
  ')-`6Q0*E1sSLET?E`=!=UgmI8._]"E%GBpW\'eR!+gI7/pmia[^.f4oW<ODr5.ajEX@ZHPq-n#!TLtKnRV:`m7HP=;ATQ*;^ttOe',
  'KD1c8Kuh<[BY>i\\lun]MlpB:*GHP/NdTMU=[=_iD3j^7Z"8m4%#&;,c]ar<oVu(E(G1s$#r[nVVV&ORhsI03T\'7J*hn`nfW!q!',
  '<eVUoKQ"ot)+kcmP7B`7`9E^9r9=.[]Dj53N$oGZ]"<X*IhE\'=^8;>k0(qKQ+bk(eUP$;"pue$XP:86LdR=C.#i(\\uU9gE13J1',
  '=o:19,KL@-Z;j-?!TB5rpT1OC@P&1-eIb$j8NI3.$jVg]pUbAK(8@V84uLf6QbRu)Cr8^is5.RL,Oam`*ZfGi"h0_=Y[*n[sBJj!',
  '*tKK&5aH,?l+pf>@gI^Tb=Ad5HS^P4\';5qN>6qM(Qof&Y]Bl<0Er8Ef%$+M:`Dq@#:ij]kX\'DH.Yk)VKrF8Kb0iA4+MI`?\\]s',
  'bMo0i=P),NTEZF@.?;+APtTXp>]FJY;L%sm<Og(b<I?-+`,tlGJ@NN!TAFqhkToo/F*SH;m]IQsm#B"ijC)H[iVu#0Sft=tB/V_a',
  '^`NIXhO^r[ST`m$+5`@99l$CFoq0FKP6WH60fI">0`9TlVGB!/jFO"[W)\\tYPU-5LbchiG+ZiJ8Rsf.sd!0CLJ8Ikag3/Xsn&aQ',
  'Pe.+F5U--!D\\^@l6]M5XXYA5*Bc+>S$rcH/8#$0\'l=d9C1I.b@BSmD7"qp/t`AI6J=RG;McnH%C)]5%L>ES0bW-Q-O[#N5\'_g',
  'fKsMb8r<E/2/)Mj#(%#%\'@FRfU\'8Dd(8AWPNXpE4-]An^Lt;[+FFFaZO"\'mPgV04<*U&Xf+H`"@F:up4_^g7_I8j@>HAJJMi',
  '\'`93s#_C`u=?je]4:,Y./?JcoLJu"K"?-j1W90Thm-O$ACg?:ad"bKgMJ0-km#B6D74(\'FKO\\Thm-O$ACg?:ad"bKgMJ0bT?c',
  'pPK83L~>',
].join('');
